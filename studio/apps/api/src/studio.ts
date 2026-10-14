import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, open, statfs, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { AudioFrame, ControlCommand, Marker, MediaPlayback, ObsState, Preparation, PreparationCheck, Project, ProjectInput, RoomConfigInput, StudioState, Take } from '@gabin/shared';
import { ObsFeedConflict, ObsMediaFailure, type ObsEvent, type ObsGateway, timecodeMs } from './obs.js';
import { emptyMediaState, type MediaGateway } from './media.js';
import { Store } from './store.js';
import { ApiFailure } from './validation.js';
import { libraryFile } from './library.js';

const slug = (name: string): string => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'production';

export class Studio {
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private readonly listeners = new Set<(state: StudioState) => void>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeMedia: () => void;
  private readonly audioListeners = new Set<(frame: AudioFrame) => void>();
  private liveProjectId: string | null = null;
  private closing = false;
  private mediaPlayback: MediaPlayback | null = null;

  constructor(readonly store: Store, readonly obs: ObsGateway, readonly media?: MediaGateway) {
    if (!store.room()) store.saveRoom({ name: 'Studio Nino', obsUrl: 'ws://127.0.0.1:4455', obsPassword: '', obsPasswordConfigured: false,
      recordingRoot: path.join(os.homedir(), 'Videos', 'Nino'), defaultScenes: { podcast: 'Podcast', roundtable: 'Table ronde', slides: 'PowerPoint' },
      liveDestination: { name: '', server: '', keyConfigured: false }, liveKey: '' });
    const legacyRoom = store.room()!;
    if (!legacyRoom.liveDestination || legacyRoom.liveKey === undefined || legacyRoom.name === 'Studio GabinHEdS') store.saveRoom({ ...legacyRoom,
      name: legacyRoom.name === 'Studio GabinHEdS' ? 'Studio Nino' : legacyRoom.name,
      liveDestination: legacyRoom.liveDestination ?? { name: '', server: '', keyConfigured: false }, liveKey: legacyRoom.liveKey ?? '' });
    // OBS has no persistent recording identity. A restart cannot safely adopt a
    // recording just because its directory/timecode happen to match old state.
    // A crash may occur between saving the take and updating activeTakeId.
    // Recover every unfinished take, including orphans, without downgrading a
    // completed take referenced by a stale activeTakeId.
    const previousTakes = store.takes();
    for (const take of previousTakes) if (take.status === 'recording' || take.status === 'paused') this.interrupt(take);
    this.store.setSetting('activeTakeId', null);
    for (const project of store.projects()) if (project.status === 'recording') {
      const latest = previousTakes.find((take) => take.projectId === project.id);
      this.setProjectStatus(project.id, latest?.status === 'completed' ? 'completed' : 'draft');
    }
    this.store.setSetting('pendingTake', null);
    this.unsubscribe = obs.subscribe((event) => {
      if (event.type === 'audio') {
        if (!this.closing) for (const listener of this.audioListeners) listener(event.frame);
        return; // Real meters are ephemeral; never increment revision or write SQLite.
      }
      const takeIdAtReception = this.activeTake()?.id ?? null;
      if (!this.closing) void this.serial(() => this.onObsEvent(event, takeIdAtReception)).catch(() => undefined);
    });
    this.unsubscribeMedia = media?.subscribe(() => {
      if (!this.closing) {
        const status = media.getState().liveStatus;
        if (status === 'idle' || status === 'error') this.liveProjectId = null;
        // These gateway states contain confirmed observations, no database
        // mutation. Publish transitional status while a start awaits packets.
        this.changed();
      }
    }) ?? (() => undefined);
  }
  subscribe(listener: (state: StudioState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  subscribeAudio(listener: (frame: AudioFrame) => void): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.unsubscribe();
    this.unsubscribeMedia();
    await this.queue.catch(() => undefined);
    // Disconnect only; the OBS recording keeps running independently.
    await this.obs.disconnect().catch(() => undefined);
    await this.media?.close().catch(() => undefined);
    this.store.close();
  }
  serial<T>(action: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }
  state(): StudioState {
    return { revision: this.revision, room: this.store.publicRoom(), obs: this.obs.getState(), media: this.media?.getState() ?? emptyMediaState(), liveProjectId: this.liveProjectId, projects: this.store.projects(),
      takes: this.store.takes(), activeTake: this.activeTake(), markers: this.store.markers(), library: this.store.library(),
      projectMedia: this.store.projectMedia(), mediaPlayback: this.obs.getMediaPlayback?.() ?? this.mediaPlayback };
  }
  libraryChanged(): StudioState { return this.changed(); }
  private changed(): StudioState {
    this.revision++;
    const state = this.state();
    for (const listener of this.listeners) listener(state);
    return state;
  }
  private activeTake(): Take | null {
    const id = this.store.setting<string>('activeTakeId');
    return id ? this.store.get<Take>('take', id) : null;
  }
  project(id: string): Project {
    const project = this.store.get<Project>('project', id);
    if (!project) throw new ApiFailure(404, 'Projet introuvable.', 'NOT_FOUND');
    return project;
  }
  createProject(input: ProjectInput): Project {
    const now = new Date().toISOString();
    const project: Project = { id: randomUUID(), title: input.title, description: input.description ?? '', owner: input.owner ?? '',
      format: input.format, participants: input.participants ?? [], defaultScene: input.defaultScene ?? null, status: 'draft', createdAt: now, updatedAt: now };
    this.store.put('project', project);
    this.changed();
    return project;
  }
  updateProject(id: string, input: Partial<ProjectInput>, status?: string): Project {
    const current = this.project(id);
    if (this.activeTake()?.projectId === id || this.liveProjectId === id) throw new ApiFailure(409, 'La préparation du projet ne peut pas changer pendant une prise ou un direct.', 'PRODUCTION_ACTIVE');
    if (status !== undefined && status !== 'archived' && status !== 'draft') throw new ApiFailure(400, 'Seuls les états brouillon et archivé peuvent être définis manuellement.');
    const project: Project = { ...current, ...input, status: status as Project['status'] ?? (current.status === 'archived' ? 'archived' : 'draft'), updatedAt: new Date().toISOString() };
    this.store.put('project', project);
    this.changed();
    return project;
  }
  updateRoom(input: RoomConfigInput): StudioState {
    if (this.activeTake() || this.obs.getState().recording || this.obs.getState().streaming || this.store.setting('pendingTake') || this.liveActive()) {
      throw new ApiFailure(409, 'Terminez ou vérifiez la prise, le retour et le direct avant de changer la configuration de la salle.', 'PRODUCTION_ACTIVE');
    }
    const { liveDestination, ...other } = input;
    const room = { ...this.store.room()!, ...other };
    if (liveDestination) {
      if (liveDestination.key !== undefined) room.liveKey = liveDestination.key;
      room.liveDestination = { name: liveDestination.name, server: liveDestination.server, keyConfigured: Boolean(room.liveKey) };
    }
    room.obsPasswordConfigured = Boolean(room.obsPassword);
    this.store.saveRoom(room);
    return this.changed();
  }
  private liveActive(): boolean {
    return ['starting', 'live', 'stopping'].includes(this.media?.getState().liveStatus ?? 'idle');
  }
  private requireMedia(): MediaGateway {
    if (!this.media) throw new ApiFailure(503, 'Le serveur de retour vidéo n’est pas configuré.', 'MEDIA_UNAVAILABLE');
    return this.media;
  }
  private async confirmObsState(confirmed: (state: ObsState) => boolean): Promise<ObsState> {
    // OBS can acknowledge an output command before its state transition ends.
    // Poll fresh observations within the command queue; queued OBS events must
    // not be needed to finish this wait, and no start command is ever replayed.
    // A local RTMP handshake can take over six seconds on the room computer.
    const deadline = Date.now() + 15_000;
    while (true) {
      let state: ObsState;
      try { state = await this.obs.refresh(true); }
      catch { throw new ApiFailure(503, 'La confirmation OBS a été perdue. Vérifiez OBS puis reconnectez : aucune commande ne sera rejouée.', 'OBS_CONFIRMATION_LOST'); }
      if (!state.connected || state.error || confirmed(state) || Date.now() >= deadline) return state;
      await new Promise(resolve => setTimeout(resolve, Math.min(200, deadline - Date.now())));
    }
  }
  private async startPreview(): Promise<void> {
    const media = this.requireMedia();
    await media.refresh();
    if (!media.getState().available) throw new ApiFailure(503, media.getState().previewError || 'Démarrez le serveur vidéo local avant d’activer le retour.', 'MEDIA_UNAVAILABLE');
    try { await this.obs.configureLocalFeed(media.ingestSettings()); }
    catch (error) { throw new ApiFailure(409, error instanceof ObsFeedConflict ? error.message : 'OBS a refusé la configuration du retour local. Vérifiez sa sortie de diffusion.', 'OBS_FEED_CONFLICT'); }
    const before = await this.obs.refresh(true);
    if (!before.connected || before.error) throw new ApiFailure(503, 'OBS ne confirme pas le retour vidéo.', 'OBS_CONFIRMATION_LOST');
    if (!before.streaming) {
      try { await this.obs.startStream(); }
      catch { throw new ApiFailure(502, 'OBS a refusé le départ du retour vidéo. Vérifiez ses paramètres de sortie.', 'PREVIEW_FAILED'); }
    }
    const after = await this.confirmObsState(state => state.streaming);
    if (!after.connected || after.error || !after.streaming) throw new ApiFailure(503, 'OBS n’a pas confirmé le départ du retour vidéo.', 'OBS_CONFIRMATION_LOST');
    // Codec/readiness can lag behind OBS streaming=true. Expose that honestly;
    // monitor/session becomes available only after MediaMTX confirms a program.
    await media.refresh();
  }
  async connect(): Promise<StudioState> {
    const config = this.store.room()!;
    if (this.obs.getState().connected) {
      await this.obs.refresh(true);
      // An inactive snapshot alone does not complete a take. An explicit
      // reconnect/check may clear a pending attribution when OBS confirms idle.
      const active = this.activeTake();
      if (active && !this.obs.getState().recording) this.interrupt(active);
      if (!this.obs.getState().recording) this.store.setSetting('pendingTake', null);
      return this.changed();
    }
    const previous = this.activeTake();
    if (previous) this.interrupt(previous);
    this.store.setSetting('pendingTake', null);
    await this.obs.connect(config.obsUrl, config.obsPassword);
    return this.changed();
  }
  async disconnect(): Promise<StudioState> {
    const previous = this.activeTake();
    await this.obs.disconnect();
    if (previous) this.interrupt(previous);
    this.store.setSetting('pendingTake', null);
    return this.changed();
  }
  private setProjectStatus(projectId: string, status: Project['status']): void {
    const project = this.project(projectId);
    this.store.put('project', { ...project, status, updatedAt: new Date().toISOString() });
  }
  private interrupt(take: Take): void {
    this.store.put('take', { ...take, status: 'interrupted', endedAt: new Date().toISOString() });
    this.store.setSetting('activeTakeId', null);
    this.setProjectStatus(take.projectId, 'draft');
  }
  private async onObsEvent(event: ObsEvent, takeIdAtReception: string | null): Promise<void> {
    if (event.type === 'recordStopped') {
      const take = this.activeTake();
      if (take && take.id === takeIdAtReception) this.finishTake(take, event.outputPath, Math.max(take.durationMs, event.durationMs));
    } else if (event.type === 'disconnected') {
      const take = this.activeTake();
      if (take && take.id === takeIdAtReception) this.interrupt(take);
      if (this.mediaPlayback) this.mediaPlayback = { ...this.mediaPlayback, status: 'unknown', error: 'OBS est déconnecté. Vérifiez la lecture sur le PC.' };
    } else if (event.type === 'state') {
      // Events may have waited behind a command. Read current state rather than
      // applying an old pre-start/pre-pause snapshot to a newly saved take.
      const latest = this.obs.getState();
      const take = this.activeTake();
      if (latest.connected && !latest.error && take && latest.recording) {
        if (latest.recordingDirectory && path.resolve(latest.recordingDirectory) !== path.resolve(take.recordingDirectory)) this.interrupt(take);
        else this.store.put('take', { ...take, status: latest.paused ? 'paused' : 'recording', durationMs: Math.max(take.durationMs, timecodeMs(latest.timecode)) });
      } else if (latest.connected && !latest.error && take && !latest.recording) {
        // The final STOPPED event carries outputPath and may arrive after an
        // inactive status poll. Keep its candidate instead of clearing it early.
        this.store.put('take', { ...take, status: 'interrupted' });
      }
    }
    this.changed();
  }
  private finishTake(take: Take, outputPath: string | null, durationMs: number): void {
    const validPath = outputPath && path.isAbsolute(outputPath) && path.relative(path.resolve(take.recordingDirectory), path.resolve(outputPath));
    const inside = validPath && !validPath.startsWith(`..${path.sep}`) && validPath !== '..' && !path.isAbsolute(validPath);
    this.store.put('take', { ...take, status: inside ? 'completed' : 'interrupted', endedAt: new Date().toISOString(), outputPath: inside ? path.resolve(outputPath!) : null, durationMs });
    this.store.setSetting('activeTakeId', null);
    this.store.setSetting('pendingTake', null);
    this.setProjectStatus(take.projectId, inside ? 'completed' : 'draft');
  }
  async preparation(projectId: string): Promise<Preparation> {
    const project = this.project(projectId);
    await this.obs.refresh(true).catch(() => undefined);
    const obs = this.obs.getState();
    const room = this.store.publicRoom();
    const sceneName = project.defaultScene || room.defaultScenes[project.format] || null;
    const folder = this.store.setting<string>(`projectFolder:${project.id}`) ?? `${slug(project.title)}-${project.id.slice(0, 8)}`;
    const recordingDirectory = path.join(room.recordingRoot, folder);
    const checks: PreparationCheck[] = [];
    checks.push({ id: 'obs', label: 'Connexion OBS', status: obs.connected && !obs.error ? 'ready' : 'blocked',
      detail: obs.connected && !obs.error ? 'OBS répond sur le PC de la salle.' : obs.error || 'Ouvrez OBS et connectez son serveur WebSocket.' });
    checks.push({ id: 'idle', label: 'Salle disponible', status: !obs.recording && !this.activeTake() && !this.store.setting('pendingTake') ? 'ready' : 'blocked',
      detail: obs.recording || this.activeTake() || this.store.setting('pendingTake') ? 'Une prise est active ou son état doit être vérifié dans OBS.' : 'Aucun enregistrement OBS en cours.' });
    checks.push({ id: 'production', label: 'Projet du direct', status: this.liveActive() && this.liveProjectId !== projectId ? 'blocked' : 'ready',
      detail: !this.liveActive() ? 'Aucun direct en cours.' : this.liveProjectId !== projectId ? 'Le direct concerne un autre projet. Terminez-le avant de changer de production.' : 'Le direct concerne ce projet.' });
    checks.push({ id: 'project', label: 'Informations de la vidéo', status: project.status !== 'archived' && project.title.trim() && project.participants.length > 0 ? 'ready' : 'blocked',
      detail: project.status === 'archived' ? 'Restaurez ce projet avant de lancer une prise.' : project.participants.length ? `${project.title} · ${project.participants.length} participant(s).` : 'Ajoutez les noms des participants avant la prise.' });
    checks.push({ id: 'scene', label: 'Scène affichée au démarrage', status: sceneName && obs.scenes.includes(sceneName) ? 'ready' : 'blocked',
      detail: sceneName && obs.scenes.includes(sceneName) ? `Scène OBS « ${sceneName} » disponible.` : 'Choisissez une scène affichée au démarrage présente dans OBS.' });
    const missingMic = project.participants.filter((person) => !person.micInput || !obs.inputs.some((input) => input.name === person.micInput && input.muted === false));
    const duplicateMics = new Set(project.participants.map((person) => person.micInput)).size !== project.participants.length;
    checks.push({ id: 'mics', label: 'Micros des participants', status: missingMic.length ? 'blocked' : duplicateMics ? 'warning' : 'ready',
      detail: missingMic.length ? `Micro absent, non audio ou coupé : ${missingMic.map((person) => person.name).join(', ')}.` : duplicateMics ? 'Plusieurs participants partagent une entrée. Les pistes séparées ne sont pas promises.' : 'Les entrées sélectionnées existent et ne sont pas coupées. Cela ne confirme pas un signal sonore.' });
    const invalidScenes = project.participants.filter((person) => person.sceneName && !obs.scenes.includes(person.sceneName));
    checks.push({ id: 'participant-scenes', label: 'Plans des participants', status: invalidScenes.length ? 'blocked' : 'ready',
      detail: invalidScenes.length ? `Plan OBS introuvable pour ${invalidScenes.map((person) => person.name).join(', ')}.` : 'Les plans renseignés existent dans OBS.' });
    checks.push({ id: 'visual-check', label: 'Contrôle image et son', status: 'warning',
      detail: project.format === 'slides' ? 'Vérifiez le cadrage, le son et le PowerPoint/HDMI avec le retour programme. Le retour HLS est différé ; les vumètres OBS correspondent au signal audio réel.' : 'Vérifiez le cadrage et écoutez les micros avec le retour programme. Le retour HLS est différé ; aucun signal audio n’est inventé quand OBS n’envoie pas de mesure.' });
    let freeBytes: number | null = null;
    try {
      await mkdir(recordingDirectory, { recursive: true });
      await access(recordingDirectory, constants.W_OK);
      const probe = path.join(recordingDirectory, `.gabin-write-${randomUUID()}`);
      const file = await open(probe, 'wx', 0o600);
      await file.close();
      await unlink(probe);
      const disk = await statfs(recordingDirectory);
      freeBytes = disk.bavail * disk.bsize;
      checks.push({ id: 'storage', label: 'Dossier des vidéos', status: 'ready', detail: `Dossier accessible sur le PC : ${recordingDirectory}` });
      checks.push({ id: 'disk', label: 'Espace disque', status: freeBytes < 1_073_741_824 ? 'blocked' : freeBytes < 10_737_418_240 ? 'warning' : 'ready',
        detail: `${(freeBytes / 1_073_741_824).toFixed(1)} Go disponibles. La durée possible dépend des réglages OBS.` });
    } catch {
      checks.push({ id: 'storage', label: 'Dossier des vidéos', status: 'blocked', detail: `Le dossier ${recordingDirectory} n’est pas accessible en écriture depuis le PC.` });
    }
    return { projectId, sceneName, recordingDirectory, freeBytes, checks, canStart: checks.every((check) => check.status !== 'blocked') };
  }
  async control(command: ControlCommand): Promise<StudioState> {
    // The relay must remain stoppable even if OBS is disconnected or uncertain.
    if (command.action === 'stream.stop') {
      await this.requireMedia().stopLive();
      this.liveProjectId = null;
      return this.changed();
    }
    await this.obs.refresh(true);
    const before = this.obs.getState();
    if (!before.connected || before.error) throw new ApiFailure(409, 'Reconnectez OBS pour vérifier l’état avant une commande.', 'OBS_UNAVAILABLE');
    const current = this.activeTake();
    switch (command.action) {
      case 'media.play': {
        if (!this.obs.playMedia) throw new ApiFailure(503, 'Cet adaptateur OBS ne permet pas encore de piloter les médias.', 'MEDIA_CONTROL_UNAVAILABLE');
        const projectId = command.projectId ?? current?.projectId ?? this.liveProjectId;
        if (projectId) {
          const project = this.project(projectId);
          if (project.status === 'archived') throw new ApiFailure(409, 'Restaurez la production avant de la piloter.', 'PROJECT_ARCHIVED');
          if (!this.store.projectMedia()[projectId]?.some(link => link.assetId === command.assetId)) throw new ApiFailure(409, 'Associez ce média à la production avant de le diffuser.', 'MEDIA_NOT_LINKED');
        }
        if (current && projectId !== current.projectId || this.liveActive() && projectId !== this.liveProjectId
          || before.recording && !current) throw new ApiFailure(409, 'La production active doit être vérifiée avant de changer son programme.', 'PROJECT_CONFLICT');
        const { asset, file } = await libraryFile(this.store, command.assetId);
        if (asset.archivedAt) throw new ApiFailure(409, 'Restaurez ce média avant de le diffuser.', 'MEDIA_ARCHIVED');
        if (asset.kind === 'document') throw new ApiFailure(400, 'Préparez le PDF ou le PowerPoint comme source dans OBS. Ce document peut être conservé et récupéré avec la production.', 'MEDIA_DOCUMENT_ONLY');
        const mode = command.mode ?? (asset.kind === 'audio' ? 'audio' : 'fullscreen');
        if (asset.kind === 'audio' && mode !== 'audio' || asset.kind !== 'audio' && mode === 'audio') throw new ApiFailure(400, 'Le mode choisi ne correspond pas à ce média.', 'MEDIA_MODE_INVALID');
        let ownerId = this.store.setting<string>('libraryOwnerId');
        if (!ownerId) { ownerId = randomUUID(); this.store.setSetting('libraryOwnerId', ownerId); }
        const ownedFiles = Object.fromEntries(this.store.list<{ id: string; fileName: string }>('mediaAsset')
          .filter(record => record.fileName.startsWith(`${record.id}.`) && path.basename(record.fileName) === record.fileName)
          .map(record => [record.id, path.join(path.dirname(file), record.fileName)]));
        try { this.mediaPlayback = await this.obs.playMedia({ assetId: asset.id, kind: asset.kind, file, mode, ownerId, ownedFiles }); }
        catch (error) { this.mediaPlayback = this.obs.getMediaPlayback?.() ?? { assetId: asset.id, status: 'unknown', mode, sceneName: null, error: 'OBS n’a pas confirmé la lecture.' }; this.changed();
          throw new ApiFailure(409, error instanceof ObsMediaFailure ? error.message : 'OBS n’a pas confirmé la lecture. Vérifiez sa source sur le PC.', 'MEDIA_OBS_FAILED'); }
        break;
      }
      case 'media.pause': case 'media.resume': case 'media.stop': {
        if (!this.obs.mediaAction) throw new ApiFailure(503, 'Cet adaptateur OBS ne permet pas de piloter les médias.', 'MEDIA_CONTROL_UNAVAILABLE');
        try { this.mediaPlayback = await this.obs.mediaAction(command.action === 'media.pause' ? 'pause' : command.action === 'media.resume' ? 'resume' : 'stop'); }
        catch (error) { this.mediaPlayback = this.obs.getMediaPlayback?.() ?? this.mediaPlayback; this.changed();
          throw new ApiFailure(409, error instanceof ObsMediaFailure ? error.message : 'OBS n’a pas confirmé cette commande média. Vérifiez sa source sur le PC.', 'MEDIA_OBS_FAILED'); }
        break;
      }
      case 'preview.start': {
        await this.startPreview();
        break;
      }
      case 'preview.stop': {
        const media = this.requireMedia();
        await media.refresh();
        if (this.liveActive()) throw new ApiFailure(409, 'Arrêtez le direct avant de couper son retour programme.', 'LIVE_ACTIVE');
        if (before.streaming) {
          try { await this.obs.configureLocalFeed(media.ingestSettings()); }
          catch { throw new ApiFailure(409, 'Ce flux OBS est externe au retour Nino. Gérez-le directement dans OBS.', 'OBS_FEED_CONFLICT'); }
          await this.obs.stopStream();
        }
        const after = await this.confirmObsState(state => !state.streaming);
        if (!after.connected || after.error || after.streaming) throw new ApiFailure(503, 'OBS n’a pas confirmé l’arrêt du retour.', 'OBS_CONFIRMATION_LOST');
        await media.refresh();
        break;
      }
      case 'stream.start': {
        const media = this.requireMedia();
        await media.refresh();
        if (this.liveActive()) throw new ApiFailure(409, 'Un direct est déjà actif ou en transition.', 'LIVE_ACTIVE');
        const project = this.project(command.projectId);
        if (this.store.setting('pendingTake') || current && (!before.recording || current.projectId !== project.id)
          || before.recording && !current) throw new ApiFailure(409, 'La prise actuelle concerne un autre projet, provient d’OBS ou reste à vérifier. Vérifiez-la avant de diffuser.', 'PROJECT_CONFLICT');
        const prep = await this.preparation(project.id);
        const commonChecks = prep.checks.filter((check) => !['idle', 'storage', 'disk'].includes(check.id));
        if (commonChecks.some((check) => check.status === 'blocked')) throw new ApiFailure(409, commonChecks.filter((check) => check.status === 'blocked').map((check) => check.detail).join(' '), 'PREPARATION_BLOCKED');
        const room = this.store.room()!;
        if (!room.liveDestination.name || !room.liveDestination.server || !room.liveKey) throw new ApiFailure(409, 'Configurez la destination et la clé du direct dans les réglages de la salle.', 'LIVE_NOT_CONFIGURED');
        const checkedObs = this.obs.getState();
        if (checkedObs.recording && (!current || current.projectId !== project.id)) throw new ApiFailure(409, 'Une autre prise a démarré dans OBS. Vérifiez-la avant de diffuser.', 'PROJECT_CONFLICT');
        if (!checkedObs.recording && !checkedObs.streaming) await this.obs.setScene(prep.sceneName!);
        await this.startPreview();
        this.liveProjectId = project.id;
        try { await media.startLive({ name: room.liveDestination.name, server: room.liveDestination.server, key: room.liveKey }); }
        catch {
          this.liveProjectId = null;
          throw new ApiFailure(502, media.getState().liveError || 'Le relais n’a pas confirmé le départ du direct. Vérifiez sa destination et sa clé.', 'LIVE_FAILED');
        }
        if (!['starting', 'live'].includes(media.getState().liveStatus)) {
          this.liveProjectId = null;
          throw new ApiFailure(503, 'Le relais n’a pas confirmé le départ du direct.', 'LIVE_NOT_STARTED');
        }
        break;
      }
      case 'record.start': {
        if (this.liveActive() && this.liveProjectId !== command.projectId) throw new ApiFailure(409, 'Le direct concerne un autre projet. Terminez-le avant de changer de production.', 'PROJECT_CONFLICT');
        const prep = await this.preparation(command.projectId);
        if (!prep.canStart) throw new ApiFailure(409, prep.checks.filter((check) => check.status === 'blocked').map((check) => check.detail).join(' '), 'PREPARATION_BLOCKED');
        const project = this.project(command.projectId);
        const previous = this.store.takes().filter((take) => take.projectId === project.id);
        const sequence = Math.max(0, ...previous.map((take) => take.sequence)) + 1;
        const takeDirectory = path.join(prep.recordingDirectory, `prise-${String(sequence).padStart(3, '0')}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        await mkdir(takeDirectory, { recursive: true });
        const take: Take = { id: randomUUID(), projectId: project.id, sequence, title: `${project.title} · Prise ${sequence}`, status: 'recording',
          startedAt: new Date().toISOString(), endedAt: null, outputPath: null, recordingDirectory: takeDirectory, durationMs: 0 };
        this.store.setSetting(`projectFolder:${project.id}`, path.basename(prep.recordingDirectory));
        // Starting a recording during an existing live keeps its current plan.
        if (!this.liveActive()) await this.obs.setScene(prep.sceneName!);
        await this.obs.setRecordDirectory(takeDirectory);
        // A private intent journal prevents a retry before OBS confirms the result.
        this.store.setSetting('pendingTake', take);
        let commandError: unknown;
        try { await this.obs.startRecord(); } catch (error) { commandError = error; }
        let result: ObsState;
        try { result = commandError ? await this.obs.refresh(true) : await this.confirmObsState(state => state.recording); } catch {
          throw new ApiFailure(503, 'La confirmation OBS a été perdue. Vérifiez dans OBS puis reconnectez : aucune relance automatique.', 'OBS_CONFIRMATION_LOST');
        }
        if (!result.connected || result.error) throw new ApiFailure(503, 'La confirmation OBS a été perdue. Vérifiez dans OBS puis reconnectez.', 'OBS_CONFIRMATION_LOST');
        if (!result.recording && !commandError) {
          // An accepted output may still start after our deadline. Retain the
          // intent until an explicit OBS check/reconnect resolves its state.
          throw new ApiFailure(503, 'OBS n’a pas confirmé le démarrage de la prise. Vérifiez dans OBS puis reconnectez : aucune relance automatique.', 'OBS_CONFIRMATION_LOST');
        }
        if (!result.recording || !result.recordingDirectory || path.resolve(result.recordingDirectory) !== path.resolve(takeDirectory)) {
          this.store.setSetting('pendingTake', null);
          throw new ApiFailure(502, commandError ? 'OBS a refusé le démarrage de la prise.' : 'OBS n’a pas confirmé le démarrage de la prise.', 'OBS_NOT_RECORDING');
        }
        this.store.put('take', { ...take, status: result.paused ? 'paused' : 'recording', durationMs: timecodeMs(result.timecode) });
        this.store.setSetting('activeTakeId', take.id);
        this.store.setSetting('pendingTake', null);
        this.setProjectStatus(project.id, 'recording');
        break;
      }
      case 'record.stop': {
        if (!current || !before.recording) throw new ApiFailure(409, 'Aucune prise Nino active. Un enregistrement externe doit être géré dans OBS.', 'NO_ACTIVE_TAKE');
        const durationMs = Math.max(current.durationMs, timecodeMs(before.timecode));
        let outputPath: string | null;
        try { ({ outputPath } = await this.obs.stopRecord()); } catch {
          throw new ApiFailure(503, 'OBS n’a pas confirmé l’arrêt. Vérifiez OBS avant de réessayer.', 'OBS_CONFIRMATION_LOST');
        }
        const after = await this.confirmObsState(state => !state.recording);
        if (!after.connected || after.error || after.recording) throw new ApiFailure(503, 'OBS n’a pas confirmé son état après l’arrêt. Vérifiez OBS avant de réessayer.', 'OBS_CONFIRMATION_LOST');
        this.finishTake(current, outputPath, durationMs);
        break;
      }
      case 'record.pause':
      case 'record.resume': {
        if (!current || !before.recording) throw new ApiFailure(409, 'Aucune prise Nino active.', 'NO_ACTIVE_TAKE');
        const paused = command.action === 'record.pause';
        if (before.paused !== paused) {
          try { if (paused) await this.obs.pauseRecord(); else await this.obs.resumeRecord(); } catch {
            throw new ApiFailure(502, 'OBS a refusé la commande. Certains formats de sortie ne permettent pas la pause.', 'OBS_COMMAND_FAILED');
          }
        }
        const after = await this.confirmObsState(state => !state.recording || state.paused === paused);
        if (!after.connected || after.error || !after.recording || after.paused !== paused) throw new ApiFailure(503, 'OBS n’a pas confirmé l’état demandé.', 'OBS_CONFIRMATION_LOST');
        this.store.put('take', { ...current, status: paused ? 'paused' : 'recording', durationMs: timecodeMs(after.timecode) });
        break;
      }
      case 'scene.set': {
        if (!before.scenes.includes(command.sceneName)) throw new ApiFailure(400, 'Ce plan n’existe pas dans OBS.');
        await this.obs.setScene(command.sceneName);
        await this.obs.refresh(true);
        if (this.obs.getState().currentScene !== command.sceneName) throw new ApiFailure(503, 'OBS n’a pas confirmé le plan demandé.', 'OBS_CONFIRMATION_LOST');
        break;
      }
      case 'input.mute': {
        if (!before.inputs.some((input) => input.name === command.inputName && input.muted !== null)) throw new ApiFailure(400, 'Cette entrée audio n’existe pas dans OBS.');
        await this.obs.setInputMute(command.inputName, command.muted);
        await this.obs.refresh(true);
        if (this.obs.getState().inputs.find((input) => input.name === command.inputName)?.muted !== command.muted) throw new ApiFailure(503, 'OBS n’a pas confirmé l’état du micro.', 'OBS_CONFIRMATION_LOST');
        break;
      }
      case 'marker.add': {
        if (!current || !before.recording) throw new ApiFailure(409, 'Les marqueurs sont disponibles pendant une prise Nino.', 'NO_ACTIVE_TAKE');
        const marker: Marker = { id: randomUUID(), takeId: current.id, label: command.label, offsetMs: timecodeMs(before.timecode), createdAt: new Date().toISOString() };
        this.store.put('marker', marker);
        break;
      }
    }
    return this.changed();
  }
}
