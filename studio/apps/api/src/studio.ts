import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, open, statfs, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { AudioFrame, AutoDirectionState, ControlCommand, Marker, MediaPlayback, ObsState, Preparation, PreparationCheck, Project, ProjectInput, RoomConfigInput, SceneChange, StudioState, Take } from '@gabin/shared';
import { ObsFeedConflict, ObsMediaFailure, type ObsEvent, type ObsGateway, timecodeMs } from './obs.js';
import { emptyMediaState, type MediaGateway } from './media.js';
import { Store } from './store.js';
import { ApiFailure, autoDirectionInput } from './validation.js';
import { libraryFile } from './library.js';
import { AUDIO_STALE_MS, AutoDirection } from './auto-direction.js';

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
  private autoDirection: AutoDirectionState = { enabled: false, status: 'off', projectId: null, participantId: null, lastAudioAt: null, lastSwitchAt: null, message: 'Réalisation manuelle.' };
  private autoEngine: AutoDirection | null = null;
  private autoOwnerId: string | null = null;
  private latestAudio: AudioFrame | null = null;
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private autoTickQueued = false;
  private lastObservedScene: string | null = null;
  private readonly now: () => number;

  constructor(readonly store: Store, readonly obs: ObsGateway, readonly media?: MediaGateway, options: { now?: () => number; autoIntervalMs?: number } = {}) {
    this.now = options.now ?? Date.now;
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
    this.lastObservedScene = obs.getState().connected ? obs.getState().currentScene : null;
    this.unsubscribe = obs.subscribe((event) => {
      if (event.type === 'audio') {
        this.latestAudio = structuredClone(event.frame);
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
    if ((options.autoIntervalMs ?? 250) > 0) {
      this.autoTimer = setInterval(() => {
        if (this.closing || !this.autoDirection.enabled || this.autoTickQueued) return;
        this.autoTickQueued = true;
        void this.serial(() => this.tickAutoDirection()).catch(() => undefined).finally(() => { this.autoTickQueued = false; });
      }, options.autoIntervalMs ?? 250);
      this.autoTimer.unref();
    }
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
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.disableAuto('off', 'Réalisation manuelle.');
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
      projectMedia: this.store.projectMedia(), mediaPlayback: this.obs.getMediaPlayback?.() ?? this.mediaPlayback,
      autoDirection: structuredClone(this.autoDirection), autoDirectionSettings: this.store.autoDirectionSettings(), sceneChanges: this.store.sceneChanges() };
  }
  libraryChanged(): StudioState { return this.changed(); }
  private setAutoState(update: Partial<AutoDirectionState>): void {
    const next = { ...this.autoDirection, ...update };
    if (JSON.stringify(next) !== JSON.stringify(this.autoDirection)) { this.autoDirection = next; this.changed(); }
  }
  private disableAuto(status: 'off' | 'suspended' | 'error', message: string): void {
    this.autoEngine = null;
    this.autoOwnerId = null;
    this.setAutoState({ enabled: false, status, participantId: null, message });
  }
  /** A revoked device cannot leave an autonomous controller running behind it. */
  revokeAutoDevice(deviceId: string): void {
    if (this.autoOwnerId === deviceId) this.disableAuto('suspended', 'L’appareil qui a activé l’automatique n’est plus autorisé. Reprenez depuis un appareil connecté.');
  }
  private autoOwnerValid(): boolean {
    const device = this.autoOwnerId && this.store.device(this.autoOwnerId);
    return Boolean(device && device.role !== 'viewer');
  }
  private fullscreenProtected(obs: ObsState): boolean {
    const playback = this.obs.getMediaPlayback?.() ?? this.mediaPlayback;
    return Boolean(playback?.mode === 'fullscreen' && (playback.sceneName === obs.currentScene || playback.status !== 'stopped'));
  }
  private autoProjectConflict(projectId: string, obs: ObsState): boolean {
    const take = this.activeTake();
    return Boolean(this.store.setting('pendingTake') || take && (!obs.recording || take.projectId !== projectId)
      || obs.recording && !take || this.liveActive() && this.liveProjectId !== projectId || this.project(projectId).status === 'archived');
  }
  private journalScene(obs: ObsState, reason: SceneChange['reason'], participantId: string | null = null, projectId?: string | null, initial = false,
    reanchor?: { previousSceneName: string | null }): void {
    if (!obs.connected || obs.error || !obs.currentScene) return;
    const previousSceneName = reanchor ? reanchor.previousSceneName : this.lastObservedScene;
    this.lastObservedScene = obs.currentScene;
    if (!initial && !reanchor && (previousSceneName === obs.currentScene || previousSceneName === null)) return;
    const take = this.activeTake();
    const productionId = take?.projectId ?? this.liveProjectId ?? projectId ?? (this.autoDirection.enabled ? this.autoDirection.projectId : null);
    if (!productionId) return;
    // During a paused take OBS timecode is frozen. Such a cut is observable but
    // must never be turned into a made-up edit point in a file that omits pauses.
    const offsetMs = take && obs.recording && !obs.paused ? initial ? 0 : timecodeMs(obs.timecode) : null;
    this.store.put<SceneChange>('sceneChange', { id: randomUUID(), projectId: productionId, takeId: take?.id ?? null,
      sceneName: obs.currentScene, previousSceneName, offsetMs, reason, participantId, createdAt: new Date(this.now()).toISOString() });
  }
  private journalResumedScene(obs: ObsState, take: Take): void {
    const lastRecordedCut = this.store.sceneChanges().filter(change => change.takeId === take.id && change.offsetMs !== null).at(-1);
    // A pause has no file duration. Anchor the resumed image using OBS time,
    // whether the operator resumed in Nino or directly in OBS.
    if (lastRecordedCut && lastRecordedCut.sceneName !== obs.currentScene) this.journalScene(obs, 'manual', null, take.projectId, false,
      { previousSceneName: lastRecordedCut.sceneName });
  }
  /** Internal watchdog, always invoked through the same queue as PC/iPad/Deck. */
  async tickAutoDirection(): Promise<void> {
    const engine = this.autoEngine;
    const projectId = this.autoDirection.projectId;
    if (!this.autoDirection.enabled || !engine || !projectId || this.closing) return;
    if (!this.autoOwnerValid()) { this.disableAuto('suspended', 'L’appareil de contrôle a expiré ou a été révoqué. Reprenez depuis un appareil connecté.'); return; }
    const before = this.obs.getState();
    if (!before.connected || before.error) { this.disableAuto('suspended', 'Connexion OBS perdue. Vérifiez le programme puis reprenez l’automatique.'); return; }
    if (this.autoProjectConflict(projectId, before)) { this.disableAuto('suspended', 'La production active ne correspond plus au projet. Vérifiez la prise et le direct.'); return; }
    if (before.currentScene !== engine.expectedScene) { this.journalScene(before, 'manual'); this.disableAuto('suspended', 'Le plan a été changé dans OBS. Reprenez l’automatique quand vous le souhaitez.'); return; }
    if (this.fullscreenProtected(before)) { this.disableAuto('suspended', 'Un média occupe le programme. Revenez au plan précédent puis reprenez l’automatique.'); return; }
    const observation = engine.observe(this.latestAudio, before, this.now());
    this.setAutoState({ status: observation.status, participantId: observation.participantId, lastAudioAt: observation.audioAt, message: observation.message });
    if (!observation.decision) return;
    // A fresh OBS snapshot checks mute/program/project immediately before the
    // cut, never the deferred HLS monitor. Authorization is checked again after
    // the await so expiry cannot issue a queued action.
    const confirmedBefore = await this.obs.refresh(true).catch(() => null);
    if (!this.autoDirection.enabled || this.autoEngine !== engine || !this.autoOwnerValid()) return;
    if (!confirmedBefore?.connected || confirmedBefore.error) { this.disableAuto('suspended', 'OBS ne confirme plus le programme. Vérifiez puis reprenez l’automatique.'); return; }
    if (confirmedBefore.currentScene !== engine.expectedScene) { this.journalScene(confirmedBefore, 'manual'); this.disableAuto('suspended', 'Le plan a été changé dans OBS. L’automatique est suspendue.'); return; }
    if (this.autoProjectConflict(projectId, confirmedBefore) || this.fullscreenProtected(confirmedBefore)) { this.disableAuto('suspended', 'La production ou le média actif a changé. Vérifiez avant de reprendre.'); return; }
    const frameAt = this.latestAudio && Date.parse(this.latestAudio.capturedAt);
    if (frameAt === null || !Number.isFinite(frameAt) || this.now() - frameAt > AUDIO_STALE_MS || frameAt - this.now() > 250
      || engine.participants.some(person => !confirmedBefore.inputs.some(input => input.name === person.micInput && input.muted === false))) {
      engine.reset(); this.setAutoState({ status: 'waiting', participantId: null, message: 'Signal audio absent, périmé ou micro coupé : aucun changement automatique.' }); return;
    }
    // If new audio arrived while OBS refreshed, reconsider it rather than cut
    // for a speaker who already stopped. A changed/unconfirmed target cancels.
    if (this.latestAudio!.capturedAt !== observation.audioAt) {
      const newest = engine.observe(this.latestAudio, confirmedBefore, this.now());
      if (!newest.decision || newest.decision.sceneName !== observation.decision.sceneName) return;
    }
    try {
      await this.obs.setScene(observation.decision.sceneName);
      const after = await this.confirmObsState(state => state.currentScene === observation.decision!.sceneName);
      if (!after.connected || after.error || after.currentScene !== observation.decision.sceneName) throw new Error('unconfirmed');
      engine.confirmScene(after.currentScene, this.now());
      this.journalScene(after, observation.decision.reason, observation.decision.participantId, projectId);
      // Revocation can happen while the OBS request is awaiting confirmation.
      // Keep the confirmed cut in the journal, but never revive its controller.
      if (!this.autoDirection.enabled || this.autoEngine !== engine) return;
      if (!this.autoOwnerValid()) { this.disableAuto('suspended', 'L’appareil de contrôle a expiré ou a été révoqué. Reprenez depuis un appareil connecté.'); return; }
      this.setAutoState({ status: 'listening', lastSwitchAt: new Date(this.now()).toISOString(), participantId: observation.decision.participantId,
        message: `Plan confirmé par OBS : ${after.currentScene}.` });
    } catch {
      if (this.autoDirection.enabled && this.autoEngine === engine) this.disableAuto('error', 'OBS n’a pas confirmé le changement de plan. Vérifiez le programme ; aucune commande ne sera rejouée.');
    }
  }
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
    if (this.autoDirection.enabled && this.autoDirection.projectId === id) this.disableAuto('suspended', 'La préparation du projet a changé. Vérifiez les micros et les plans puis reprenez l’automatique.');
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
    if (this.autoDirection.enabled) this.disableAuto('suspended', 'La configuration de la salle a changé. Vérifiez OBS puis reprenez l’automatique.');
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
    this.lastObservedScene = this.obs.getState().currentScene;
    return this.changed();
  }
  async disconnect(): Promise<StudioState> {
    if (this.autoDirection.enabled) this.disableAuto('suspended', 'OBS a été déconnecté. Vérifiez puis reprenez l’automatique.');
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
      if (this.autoDirection.enabled) this.disableAuto('suspended', 'Connexion OBS perdue. Vérifiez le programme puis reprenez l’automatique.');
      const take = this.activeTake();
      if (take && take.id === takeIdAtReception) this.interrupt(take);
      if (this.mediaPlayback) this.mediaPlayback = { ...this.mediaPlayback, status: 'unknown', error: 'OBS est déconnecté. Vérifiez la lecture sur le PC.' };
    } else if (event.type === 'state') {
      // Events may have waited behind a command. Read current state rather than
      // applying an old pre-start/pre-pause snapshot to a newly saved take.
      const latest = this.obs.getState();
      if (latest.connected && !latest.error) {
        this.journalScene(latest, 'manual');
        if (this.autoDirection.enabled && this.autoEngine && latest.currentScene !== this.autoEngine.expectedScene) {
          this.disableAuto('suspended', 'Le plan a été changé dans OBS. Reprenez l’automatique quand vous le souhaitez.');
        }
      }
      const take = this.activeTake();
      if (latest.connected && !latest.error && take && latest.recording) {
        if (latest.recordingDirectory && path.resolve(latest.recordingDirectory) !== path.resolve(take.recordingDirectory)) this.interrupt(take);
        else {
          this.store.put('take', { ...take, status: latest.paused ? 'paused' : 'recording', durationMs: Math.max(take.durationMs, timecodeMs(latest.timecode)) });
          if (take.status === 'paused' && !latest.paused) this.journalResumedScene(latest, take);
        }
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
    if (this.autoDirection.enabled && !this.liveActive()) this.disableAuto('off', 'Prise terminée : réalisation manuelle.');
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
  async control(command: ControlCommand, actor?: { deviceId: string }): Promise<StudioState> {
    if (command.action === 'auto.stop') {
      this.disableAuto('off', 'Réalisation manuelle.');
      return this.changed();
    }
    if (command.action === 'auto.configure') {
      const project = this.project(command.projectId);
      if (project.status === 'archived') throw new ApiFailure(409, 'Restaurez la production avant de configurer l’automatique.', 'PROJECT_ARCHIVED');
      const settings = autoDirectionInput(command.settings);
      if (this.autoDirection.enabled && this.autoDirection.projectId === project.id) this.disableAuto('suspended', 'Les réglages ont changé. Reprenez l’automatique pour les appliquer.');
      this.store.put('autoDirectionConfig', { id: project.id, settings });
      return this.changed();
    }
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
    const directionProjectId = this.autoDirection.enabled ? this.autoDirection.projectId : null;
    if (this.lastObservedScene === null) this.lastObservedScene = before.currentScene;
    switch (command.action) {
      case 'auto.start': {
        const project = this.project(command.projectId);
        const device = actor && this.store.device(actor.deviceId);
        if (!device || device.role === 'viewer') throw new ApiFailure(403, 'Un appareil de contrôle autorisé doit activer l’automatique.', 'AUTO_AUTH_REQUIRED');
        if (this.autoProjectConflict(project.id, before)) throw new ApiFailure(409, 'La prise ou le direct concerne un autre projet ou reste à vérifier.', 'PROJECT_CONFLICT');
        if (this.fullscreenProtected(before)) throw new ApiFailure(409, 'Revenez au plan précédent avant de reprendre l’automatique.', 'AUTO_MEDIA_ACTIVE');
        const saved = this.store.autoDirectionSettings()[project.id];
        if (!saved) throw new ApiFailure(409, 'Choisissez le plan large et les réglages de réalisation automatique.', 'AUTO_NOT_CONFIGURED');
        const settings = autoDirectionInput(saved);
        if (!project.participants.length || project.participants.some(person => !person.micInput || !person.sceneName
          || !before.inputs.some(input => input.name === person.micInput && input.muted === false) || !before.scenes.includes(person.sceneName))
          || !before.scenes.includes(settings.wideScene)) throw new ApiFailure(409, 'Chaque participant doit avoir un micro actif et un plan OBS disponible, ainsi qu’un plan large.', 'AUTO_SETUP_REQUIRED');
        if (new Set(project.participants.map(person => person.micInput)).size !== project.participants.length) throw new ApiFailure(409, 'La réalisation automatique nécessite une entrée micro distincte par participant.', 'AUTO_DISTINCT_MICS');
        if (new Set(project.participants.map(person => person.sceneName)).size !== project.participants.length
          || new Set([settings.wideScene, ...project.participants.map(person => person.sceneName)]).size < 2) throw new ApiFailure(409, 'Choisissez un plan distinct par participant et un plan large permettant un changement de caméra.', 'AUTO_DISTINCT_SCENES');
        this.autoOwnerId = device.id;
        this.autoEngine = new AutoDirection(structuredClone(project.participants), settings, before.currentScene, this.now());
        this.setAutoState({ enabled: true, status: 'waiting', projectId: project.id, participantId: null, lastAudioAt: null, lastSwitchAt: null,
          message: 'Automatique activée : en attente de mesures OBS récentes sur chaque micro.' });
        break;
      }
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
        if (mode === 'fullscreen' && this.autoDirection.enabled) this.disableAuto('suspended', 'Média plein écran : l’automatique est suspendue. Revenez au plan précédent puis reprenez-la.');
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
        if (this.autoDirection.enabled && this.autoDirection.projectId !== project.id) this.disableAuto('suspended', 'Le direct concerne un autre projet. L’automatique est suspendue.');
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
        this.autoEngine?.confirmScene(this.obs.getState().currentScene, this.now());
        this.journalScene(this.obs.getState(), 'start', null, project.id);
        break;
      }
      case 'record.start': {
        if (this.autoDirection.enabled && this.autoDirection.projectId !== command.projectId) this.disableAuto('suspended', 'L’enregistrement concerne un autre projet. L’automatique est suspendue.');
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
        this.autoEngine?.confirmScene(result.currentScene, this.now());
        this.journalScene(result, 'start', null, project.id, true);
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
        if (!paused && before.paused) this.journalResumedScene(after, current);
        break;
      }
      case 'scene.set': {
        if (!before.scenes.includes(command.sceneName)) throw new ApiFailure(400, 'Ce plan n’existe pas dans OBS.');
        if (this.autoDirection.enabled) this.disableAuto('suspended', 'Vous avez choisi un plan manuellement. Reprenez l’automatique quand vous le souhaitez.');
        await this.obs.setScene(command.sceneName);
        await this.obs.refresh(true);
        if (!this.obs.getState().connected || this.obs.getState().error || this.obs.getState().currentScene !== command.sceneName) throw new ApiFailure(503, 'OBS n’a pas confirmé le plan demandé.', 'OBS_CONFIRMATION_LOST');
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
    if (command.action.startsWith('media.')) this.journalScene(this.obs.getState(), 'media', null, directionProjectId);
    if (command.action === 'scene.set') this.journalScene(this.obs.getState(), 'manual', null, directionProjectId);
    return this.changed();
  }
}
