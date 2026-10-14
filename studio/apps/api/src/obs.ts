import OBSWebSocket, { EventSubscription, type OBSRequestTypes, type OBSResponseTypes } from 'obs-websocket-js/json';
import path from 'node:path';
import type { AudioFrame, MediaKind, MediaMode, MediaPlayback, ObsState, SceneThumbnail } from '@gabin/shared';

export type ObsEvent =
  | { type: 'state'; state: ObsState }
  | { type: 'recordStopped'; outputPath: string | null; durationMs: number }
  | { type: 'audio'; frame: AudioFrame }
  | { type: 'disconnected' };
export class ObsFeedConflict extends Error {}
export class ObsMediaFailure extends Error {}
export interface ObsMediaOptions { assetId: string; ownerId: string; kind: Exclude<MediaKind, 'document'>; file: string; mode: MediaMode; ownedFiles?: Record<string, string> }

/** The real adapter and tests share this interface. No command assumes success. */
export interface ObsGateway {
  getState(): ObsState;
  connect(url: string, password: string): Promise<ObsState>;
  disconnect(): Promise<void>;
  refresh(fresh?: boolean): Promise<ObsState>;
  sceneThumbnail(sceneName: string): Promise<SceneThumbnail>;
  setScene(sceneName: string): Promise<void>;
  setInputMute(inputName: string, muted: boolean): Promise<void>;
  setRecordDirectory(directory: string): Promise<void>;
  startRecord(): Promise<void>;
  stopRecord(): Promise<{ outputPath: string | null }>;
  pauseRecord(): Promise<void>;
  resumeRecord(): Promise<void>;
  configureLocalFeed(settings: { server: string; key: string }): Promise<void>;
  startStream(): Promise<void>;
  stopStream(): Promise<void>;
  playMedia?(options: ObsMediaOptions): Promise<MediaPlayback>;
  mediaAction?(action: 'pause' | 'resume' | 'stop'): Promise<MediaPlayback>;
  getMediaPlayback?(): MediaPlayback | null;
  subscribe(listener: (event: ObsEvent) => void): () => void;
}

export function emptyObsState(): ObsState {
  return { connected: false, connecting: false, error: null, scenes: [], currentScene: null,
    inputs: [], recording: false, paused: false, timecode: '00:00:00.000', recordingDirectory: null, outputBytes: 0,
    streaming: false, streamReconnecting: false, streamTimecode: '00:00:00.000', streamOutputBytes: 0 };
}

export function timecodeMs(timecode: string): number {
  const match = /^(\d+):(\d+):(\d+)(?:\.(\d+))?$/.exec(timecode);
  if (!match) return 0;
  return (+match[1] * 3600 + +match[2] * 60 + +match[3]) * 1000 + +(match[4] ?? '0').padEnd(3, '0').slice(0, 3);
}

export class RealObsGateway implements ObsGateway {
  private readonly client = new OBSWebSocket();
  private state: ObsState = emptyObsState();
  private readonly listeners = new Set<(event: ObsEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<ObsState> | null = null;
  private connectionEpoch = 0;
  private lastAudioFrameAt = 0;
  private readonly thumbnails = new Map<string, { result: SceneThumbnail; expiresAt: number; epoch: number }>();
  private readonly thumbnailRequests = new Map<string, Promise<SceneThumbnail>>();
  private thumbnailActive = 0;
  private readonly thumbnailWaiting = new Set<() => void>();
  private mediaSelection: (ObsMediaOptions & { inputName: string; sceneName: string; sceneItemId: number; previousScene: string | null; playback: MediaPlayback }) | null = null;
  private readonly createdMediaScenes = new Set<string>();

  constructor() {
    this.client.on('ConnectionClosed', () => {
      this.connectionEpoch++;
      this.stopPolling();
      this.createdMediaScenes.clear();
      // Preserve the last known recording fields. Disconnected does NOT mean stopped.
      this.state = { ...this.state, connected: false, connecting: false, error: 'Connexion OBS interrompue. État de l’enregistrement à vérifier dans OBS.' };
      this.emit({ type: 'disconnected' });
      this.emit({ type: 'state', state: this.getState() });
    });
    this.client.on('ConnectionError', () => {
      this.state.error = 'Impossible de communiquer avec OBS. Vérifiez le serveur WebSocket et le mot de passe.';
    });
    this.client.on('RecordStateChanged', (event) => {
      if (event.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
        this.emit({ type: 'recordStopped', outputPath: event.outputPath || null, durationMs: timecodeMs(this.state.timecode) });
      }
      void this.refresh().catch(() => undefined);
    });
    this.client.on('StreamStateChanged', () => { void this.refresh().catch(() => undefined); });
    this.client.on('InputVolumeMeters', (event) => {
      const now = Date.now();
      if (!this.state.connected || now - this.lastAudioFrameAt < 100) return;
      const frame = audioFrame(event.inputs, now);
      this.lastAudioFrameAt = now;
      this.emit({ type: 'audio', frame });
    });
    for (const event of ['CurrentProgramSceneChanged', 'InputMuteStateChanged', 'InputVolumeChanged', 'SceneListChanged', 'InputCreated', 'InputRemoved'] as const) {
      this.client.on(event, () => { void this.refresh().catch(() => undefined); });
    }
  }

  getState(): ObsState { return structuredClone(this.state); }
  getMediaPlayback(): MediaPlayback | null {
    if (!this.mediaSelection) return null;
    return structuredClone(this.state.connected ? this.mediaSelection.playback : { ...this.mediaSelection.playback, status: 'unknown', error: 'Connexion OBS interrompue. Vérifiez le média sur le PC.' });
  }
  subscribe(listener: (event: ObsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: ObsEvent): void { for (const listener of this.listeners) listener(event); }
  private stopPolling(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private async bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (this.state.connected || this.state.connecting) {
          this.connectionEpoch++;
          this.stopPolling();
          this.state = { ...this.state, connected: false, connecting: false, error: 'OBS ne répond plus. Vérifiez son état puis reconnectez, aucune commande ne sera rejouée.' };
          this.emit({ type: 'disconnected' });
          this.emit({ type: 'state', state: this.getState() });
          void this.client.disconnect().catch(() => undefined);
        }
        reject(new Error('Délai de réponse OBS dépassé.'));
      }, 8000);
      timer.unref();
    });
    try { return await Promise.race([promise, timeout]); }
    finally { clearTimeout(timer!); }
  }
  private call<T extends keyof OBSRequestTypes>(type: T, data?: OBSRequestTypes[T]): Promise<OBSResponseTypes[T]> {
    return this.bounded(this.client.call(type, data));
  }

  async connect(url: string, password: string): Promise<ObsState> {
    if (this.state.connected) await this.disconnect();
    this.connectionEpoch++;
    this.state = { ...this.state, connecting: true, error: null };
    this.emit({ type: 'state', state: this.getState() });
    try {
      await this.bounded(this.client.connect(url, password || undefined, { rpcVersion: 1,
        eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters }));
      this.state = { ...this.state, connected: true, connecting: false, error: null };
      await this.refresh(true);
      this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, 1000);
      this.timer.unref();
      return this.getState();
    } catch {
      this.state = { ...this.state, connected: false, connecting: false, error: 'Connexion OBS refusée. Vérifiez OBS, son serveur WebSocket et le mot de passe.' };
      this.emit({ type: 'state', state: this.getState() });
      throw new Error(this.state.error!);
    }
  }

  async disconnect(): Promise<void> {
    this.connectionEpoch++;
    this.stopPolling();
    this.createdMediaScenes.clear();
    await this.bounded(this.client.disconnect());
    this.state = { ...this.state, connected: false, connecting: false, error: null };
    this.emit({ type: 'state', state: this.getState() });
  }

  async refresh(fresh = false): Promise<ObsState> {
    // Confirmation must read after command ACK, never join a pre-command snapshot.
    if (fresh) while (this.refreshInFlight) await this.refreshInFlight.catch(() => undefined);
    if (!this.state.connected) return this.getState();
    if (this.refreshInFlight) return this.refreshInFlight;
    const promise = this.readState(this.connectionEpoch).finally(() => { if (this.refreshInFlight === promise) this.refreshInFlight = null; });
    this.refreshInFlight = promise;
    return promise;
  }

  /** Read-only requests never enter the recording command queue or alter its
   * connection state on timeout. Limit outstanding work even if OBS is slow. */
  async sceneThumbnail(sceneName: string): Promise<SceneThumbnail> {
    const unavailable = (): SceneThumbnail => ({ sceneName, imageData: null, capturedAt: null, available: false });
    if (!this.state.connected || !this.state.scenes.includes(sceneName)) return unavailable();
    const epoch = this.connectionEpoch;
    const cached = this.thumbnails.get(sceneName);
    if (cached?.epoch === epoch && cached.expiresAt > Date.now()) return { ...cached.result };
    const key = `${epoch}:${sceneName}`;
    const pending = this.thumbnailRequests.get(key);
    if (pending) return pending;
    const result = (async () => {
      if (!await this.thumbnailSlot()) return unavailable();
      if (!this.state.connected || this.connectionEpoch !== epoch || !this.state.scenes.includes(sceneName)) {
        this.releaseThumbnailSlot(); return unavailable();
      }
      const capture = this.client.call('GetSourceScreenshot', { sourceName: sceneName, imageFormat: 'jpeg',
        imageWidth: 320, imageHeight: 180, imageCompressionQuality: 65 }).finally(() => this.releaseThumbnailSlot());
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2500); timer.unref(); });
      let response: OBSResponseTypes['GetSourceScreenshot'] | null;
      try { response = await Promise.race([capture.catch(() => null), timeout]); }
      finally { clearTimeout(timer!); }
      if (!this.state.connected || this.connectionEpoch !== epoch || !this.state.scenes.includes(sceneName)) return unavailable();
      const image = response?.imageData;
      // OBS uses a data URI; do not forward arbitrary content or an unbounded image.
      const valid = typeof image === 'string' && image.length <= 1024 * 1024
        && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)
        && Buffer.from(image.slice(image.indexOf(',') + 1), 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8]));
      const value: SceneThumbnail = valid ? { sceneName, imageData: image, capturedAt: new Date().toISOString(), available: true } : unavailable();
      if (this.thumbnails.size >= 64 && !this.thumbnails.has(sceneName)) this.thumbnails.delete(this.thumbnails.keys().next().value!);
      this.thumbnails.set(sceneName, { result: value, expiresAt: Date.now() + 5000, epoch });
      return value;
    })().finally(() => { this.thumbnailRequests.delete(key); });
    this.thumbnailRequests.set(key, result);
    return result;
  }

  private async thumbnailSlot(): Promise<boolean> {
    if (this.thumbnailActive < 2) { this.thumbnailActive++; return true; }
    if (this.thumbnailWaiting.size >= 12) return false;
    return new Promise(resolve => {
      const waiting = () => { clearTimeout(timer); this.thumbnailActive++; resolve(true); };
      const timer = setTimeout(() => { this.thumbnailWaiting.delete(waiting); resolve(false); }, 2500);
      timer.unref();
      this.thumbnailWaiting.add(waiting);
    });
  }

  private releaseThumbnailSlot(): void {
    this.thumbnailActive--;
    const next = this.thumbnailWaiting.values().next().value;
    if (next) { this.thumbnailWaiting.delete(next); next(); }
  }

  private async readState(epoch: number): Promise<ObsState> {
    try {
      const [scenes, inputs, record, directory, stream] = await Promise.all([
        this.call('GetSceneList'), this.call('GetInputList'),
        this.call('GetRecordStatus'), this.call('GetRecordDirectory'), this.call('GetStreamStatus'),
      ]);
      const inputStates = await Promise.all(inputs.inputs.map(async (input) => {
        const name = String(input.inputName);
        const [mute, volume] = await Promise.allSettled([
          this.call('GetInputMute', { inputName: name }),
          this.call('GetInputVolume', { inputName: name }),
        ]);
        return { name, kind: String(input.inputKind),
          muted: mute.status === 'fulfilled' ? mute.value.inputMuted : null,
          volumeDb: volume.status === 'fulfilled' && Number.isFinite(volume.value.inputVolumeDb) ? volume.value.inputVolumeDb : null };
      }));
      // A disconnect during the requests cannot restore a connected flag.
      if (!this.state.connected || epoch !== this.connectionEpoch) return this.getState();
      this.state = { connected: true, connecting: false, error: null,
        scenes: scenes.scenes.map((scene) => String(scene.sceneName)), currentScene: scenes.currentProgramSceneName,
        inputs: inputStates, recording: record.outputActive, paused: record.outputPaused,
        timecode: record.outputTimecode, outputBytes: record.outputBytes, recordingDirectory: directory.recordDirectory,
        streaming: stream.outputActive, streamReconnecting: stream.outputReconnecting,
        streamTimecode: stream.outputTimecode, streamOutputBytes: stream.outputBytes };
      if (this.mediaSelection) await this.observeMedia().catch(() => {
        if (this.mediaSelection) this.mediaSelection.playback = { ...this.mediaSelection.playback, status: 'unknown', error: 'OBS ne confirme plus l’état du média. Vérifiez sa source.' };
      });
      this.emit({ type: 'state', state: this.getState() });
      return this.getState();
    } catch {
      if (epoch !== this.connectionEpoch) return this.getState();
      this.state.error = 'OBS ne répond pas à toutes les vérifications. Réessayez la connexion avant une commande.';
      this.emit({ type: 'state', state: this.getState() });
      throw new Error(this.state.error);
    }
  }

  async setScene(sceneName: string): Promise<void> { await this.call('SetCurrentProgramScene', { sceneName }); }
  async setInputMute(inputName: string, muted: boolean): Promise<void> { await this.call('SetInputMute', { inputName, inputMuted: muted }); }
  async setRecordDirectory(recordDirectory: string): Promise<void> { await this.call('SetRecordDirectory', { recordDirectory }); }
  async startRecord(): Promise<void> { await this.call('StartRecord'); }
  async stopRecord(): Promise<{ outputPath: string | null }> { const result = await this.call('StopRecord'); return { outputPath: result.outputPath || null }; }
  async pauseRecord(): Promise<void> { await this.call('PauseRecord'); }
  async resumeRecord(): Promise<void> { await this.call('ResumeRecord'); }
  async configureLocalFeed(settings: { server: string; key: string }): Promise<void> {
    let url: URL;
    try { url = new URL(settings.server); } catch { throw new Error('Adresse du retour vidéo local invalide.'); }
    if (url.protocol !== 'rtmp:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash
      || !settings.key || settings.key.includes('/') || settings.key.includes('\\')) throw new Error('Le retour OBS doit utiliser le relais local de la salle.');
    const stream = await this.call('GetStreamStatus');
    if (stream.outputActive) {
      const current = await this.call('GetStreamServiceSettings');
      if (current.streamServiceType !== 'rtmp_custom' || current.streamServiceSettings.server !== settings.server || current.streamServiceSettings.key !== settings.key) {
        throw new ObsFeedConflict('OBS diffuse déjà vers une destination externe. Arrêtez ce flux dans OBS avant d’activer le retour Nino.');
      }
      return;
    }
    await this.call('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: settings.server, key: settings.key, use_auth: false } });
  }
  async startStream(): Promise<void> { await this.call('StartStream'); }
  async stopStream(): Promise<void> { await this.call('StopStream'); }

  private mediaInputName(options: Pick<ObsMediaOptions, 'ownerId' | 'assetId'>): string { return `Nino · ${options.ownerId.slice(0, 8)} · ${options.assetId}`; }
  private async assertMediaOwnership(options: ObsMediaOptions, inputName: string): Promise<OBSResponseTypes['GetInputSettings']> {
    const result = await this.call('GetInputSettings', { inputName });
    const expectedKind = options.kind === 'image' ? 'image_source' : 'ffmpeg_source';
    const filename = options.kind === 'image' ? result.inputSettings.file : result.inputSettings.local_file;
    if (result.inputKind !== expectedKind || result.inputSettings.nino_owner !== options.ownerId || result.inputSettings.nino_asset !== options.assetId
      || filename !== options.file || options.kind !== 'image' && result.inputSettings.is_local_file !== true) throw new ObsMediaFailure('Cette source OBS a été modifiée ou appartient à une autre configuration. Nino ne la remplacera pas.');
    return result;
  }
  private settingsOwned(options: ObsMediaOptions, inputName: string, settings: OBSResponseTypes['GetInputSettings']): boolean {
    const assetId = settings.inputSettings.nino_asset;
    if (typeof assetId !== 'string' || settings.inputSettings.nino_owner !== options.ownerId || inputName !== this.mediaInputName({ ownerId: options.ownerId, assetId })) return false;
    const expectedFile = assetId === options.assetId ? options.file : options.ownedFiles?.[assetId];
    return !!expectedFile && (settings.inputKind === 'image_source' && settings.inputSettings.file === expectedFile
      || settings.inputKind === 'ffmpeg_source' && settings.inputSettings.is_local_file === true && settings.inputSettings.local_file === expectedFile);
  }
  private async ownedScene(sceneName: string, options: ObsMediaOptions): Promise<void> {
    const { sceneItems } = await this.call('GetSceneItemList', { sceneName });
    if (!sceneItems.length && this.createdMediaScenes.has(sceneName)) return;
    if (!sceneItems.length) throw new ObsMediaFailure('La scène « Nino · Médias » existe déjà sans source Nino identifiable. Renommez-la dans OBS pour préserver sa configuration.');
    for (const item of sceneItems) {
      const inputName = String(item.sourceName);
      const settings = await this.call('GetInputSettings', { inputName }).catch(() => null);
      if (!settings || !this.settingsOwned(options, inputName, settings)) throw new ObsMediaFailure('La scène « Nino · Médias » contient une source étrangère ou modifiée. Nino ne modifiera pas cette scène.');
    }
  }
  private async disableOwnedMedia(options: ObsMediaOptions): Promise<void> {
    const prefix = `Nino · ${options.ownerId.slice(0, 8)} · `;
    const candidates = new Set(this.state.inputs.filter(input => input.name.startsWith(prefix)).map(input => input.name));
    if (!candidates.size) return;
    const items: { sceneName: string; sceneItemId: number }[] = [];
    for (const sceneName of this.state.scenes) {
      const { sceneItems } = await this.call('GetSceneItemList', { sceneName });
      for (const item of sceneItems) {
        const inputName = String(item.sourceName);
        if (!candidates.has(inputName)) continue;
        const settings = await this.call('GetInputSettings', { inputName });
        if (!this.settingsOwned(options, inputName, settings)) throw new ObsMediaFailure('Une ancienne source média Nino a été modifiée dans OBS. Vérifiez-la avant d’en lancer une nouvelle.');
        items.push({ sceneName, sceneItemId: Number(item.sceneItemId) });
      }
    }
    for (const item of items) await this.call('SetSceneItemEnabled', { ...item, sceneItemEnabled: false });
  }
  async playMedia(options: ObsMediaOptions): Promise<MediaPlayback> {
    if (!this.state.connected || !path.isAbsolute(options.file) || /[\r\n\0]/.test(options.file)) throw new ObsMediaFailure('Reconnectez OBS avant de lancer ce média.');
    await this.refresh(true);
    if (this.mediaSelection && this.mediaSelection.playback.status !== 'stopped') await this.mediaAction('stop');
    const previousScene = this.state.currentScene;
    const sceneName = options.mode === 'fullscreen' ? 'Nino · Médias' : previousScene;
    if (!sceneName) throw new ObsMediaFailure('Choisissez d’abord un plan dans OBS.');
    if (options.mode === 'fullscreen') {
      if (this.state.scenes.includes(sceneName)) await this.ownedScene(sceneName, options);
      else { await this.call('CreateScene', { sceneName }); this.createdMediaScenes.add(sceneName); }
    }
    const inputName = this.mediaInputName(options);
    const inputKind = options.kind === 'image' ? 'image_source' : 'ffmpeg_source';
    const inputSettings: OBSRequestTypes['SetInputSettings']['inputSettings'] = options.kind === 'image' ? { file: options.file, nino_owner: options.ownerId, nino_asset: options.assetId }
      : { is_local_file: true, local_file: options.file, looping: false, restart_on_activate: false, clear_on_media_end: true, close_when_inactive: true, nino_owner: options.ownerId, nino_asset: options.assetId };
    let sceneItemId: number;
    if (this.state.inputs.some(input => input.name === inputName)) {
      await this.assertMediaOwnership(options, inputName);
      await this.call('SetInputSettings', { inputName, inputSettings, overlay: false });
      const { sceneItems } = await this.call('GetSceneItemList', { sceneName });
      const item = sceneItems.find(item => item.sourceName === inputName);
      sceneItemId = item ? Number(item.sceneItemId) : (await this.call('CreateSceneItem', { sceneName, sourceName: inputName, sceneItemEnabled: false })).sceneItemId;
    } else {
      sceneItemId = (await this.call('CreateInput', { sceneName, inputName, inputKind, inputSettings, sceneItemEnabled: false })).sceneItemId;
    }
    // Do not touch camera/microphone sources, including sources whose names only
    // resemble Nino. Owned local sources are disabled before the next one opens.
    await this.disableOwnedMedia(options);
    await this.assertMediaOwnership(options, inputName);
    this.mediaSelection = { ...options, inputName, sceneName, sceneItemId, previousScene,
      playback: { assetId: options.assetId, status: 'unknown', mode: options.mode, sceneName, error: 'En attente de confirmation OBS.' } };
    try {
      if (options.kind !== 'audio') {
        const video = await this.call('GetVideoSettings');
        const overlay = options.mode === 'overlay';
        await this.call('SetSceneItemTransform', { sceneName, sceneItemId, sceneItemTransform: {
          positionX: overlay ? Math.max(0, video.baseWidth * .75 - 24) : 0,
          positionY: overlay ? Math.max(0, video.baseHeight * .75 - 24) : 0,
          boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: video.baseWidth * (overlay ? .25 : 1), boundsHeight: video.baseHeight * (overlay ? .25 : 1), alignment: 5, boundsAlignment: 0,
        } });
      }
      await this.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: true });
      if (options.mode === 'fullscreen') await this.setScene(sceneName);
      if (options.kind !== 'image') await this.call('TriggerMediaInputAction', { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' });
      await this.confirmMedia(options.kind === 'image' ? 'shown' : 'playing');
      return this.getMediaPlayback()!;
    } catch (error) {
      this.mediaSelection.playback = { ...this.mediaSelection.playback, status: 'unknown', error: 'OBS n’a pas confirmé la lecture. Vérifiez le média sur le PC.' };
      throw error;
    }
  }
  private async observeMedia(): Promise<MediaPlayback> {
    const selected = this.mediaSelection;
    if (!selected || !this.state.connected) throw new ObsMediaFailure('Aucun média Nino confirmé dans OBS.');
    await this.assertMediaOwnership(selected, selected.inputName);
    const enabled = await this.call('GetSceneItemEnabled', { sceneName: selected.sceneName, sceneItemId: selected.sceneItemId });
    let status: MediaPlayback['status'];
    if (selected.kind === 'image') status = enabled.sceneItemEnabled ? 'shown' : 'stopped';
    else {
      const observation = await this.call('GetMediaInputStatus', { inputName: selected.inputName });
      status = observation.mediaState === 'OBS_MEDIA_STATE_PLAYING' ? 'playing' : observation.mediaState === 'OBS_MEDIA_STATE_PAUSED' ? 'paused'
        : ['OBS_MEDIA_STATE_STOPPED', 'OBS_MEDIA_STATE_ENDED', 'OBS_MEDIA_STATE_NONE'].includes(observation.mediaState) ? 'stopped' : 'unknown';
      if (!enabled.sceneItemEnabled && status !== 'stopped') status = 'unknown';
    }
    const scenes = await this.call('GetSceneList');
    const sceneChanged = enabled.sceneItemEnabled && scenes.currentProgramSceneName !== selected.sceneName && status !== 'stopped';
    if (sceneChanged) status = 'unknown';
    selected.playback = { ...selected.playback, status, error: sceneChanged ? 'Le plan programme a changé. Ce média n’est plus confirmé à l’écran.' : status === 'unknown' ? 'OBS prépare le média ou ne confirme plus sa lecture.' : null };
    return selected.playback;
  }
  private async confirmMedia(expected: MediaPlayback['status']): Promise<void> {
    const deadline = Date.now() + 5000;
    while (true) {
      const result = await this.observeMedia();
      if (result.status === expected) return;
      if (Date.now() >= deadline) throw new ObsMediaFailure('OBS n’a pas confirmé l’état demandé du média. Vérifiez sa source avant de recommencer.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  async mediaAction(action: 'pause' | 'resume' | 'stop'): Promise<MediaPlayback> {
    const selected = this.mediaSelection;
    if (!selected || !this.state.connected) throw new ObsMediaFailure('Aucun média Nino actif ou OBS déconnecté.');
    if (selected.kind === 'image' && action !== 'stop') throw new ObsMediaFailure('Une image reste affichée jusqu’à son arrêt ; elle ne se met pas en pause.');
    await this.assertMediaOwnership(selected, selected.inputName);
    if (selected.kind !== 'image') await this.call('TriggerMediaInputAction', { inputName: selected.inputName,
      mediaAction: action === 'pause' ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' : action === 'resume' ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' : 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' });
    if (action === 'stop') {
      await this.call('SetSceneItemEnabled', { sceneName: selected.sceneName, sceneItemId: selected.sceneItemId, sceneItemEnabled: false });
      // If an operator has chosen another plan, never force them back.
      const scenes = await this.call('GetSceneList');
      if (selected.mode === 'fullscreen' && scenes.currentProgramSceneName === selected.sceneName && selected.previousScene && selected.previousScene !== selected.sceneName
        && scenes.scenes.some(scene => scene.sceneName === selected.previousScene)) await this.setScene(selected.previousScene);
    }
    try { await this.confirmMedia(action === 'pause' ? 'paused' : action === 'resume' ? 'playing' : 'stopped'); }
    catch (error) { selected.playback = { ...selected.playback, status: 'unknown', error: 'OBS n’a pas confirmé cette commande média.' }; throw error; }
    return this.getMediaPlayback()!;
  }
}

/** OBS sends post-fader magnitude and peak as linear amplitude per channel. */
export function audioFrame(inputs: unknown[], capturedAt = Date.now()): AudioFrame {
  const toDb = (linear: number): number => Math.max(-100, Math.min(20, linear > 0 ? 20 * Math.log10(linear) : -100));
  return { capturedAt: new Date(capturedAt).toISOString(), inputs: inputs.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const input = item as { inputName?: unknown; inputLevelsMul?: unknown };
    if (typeof input.inputName !== 'string' || !Array.isArray(input.inputLevelsMul)) return [];
    const channels = input.inputLevelsMul.filter((value): value is [number, number, number] => Array.isArray(value)
      && typeof value[0] === 'number' && Number.isFinite(value[0]) && value[0] >= 0
      && typeof value[1] === 'number' && Number.isFinite(value[1]) && value[1] >= 0);
    if (!channels.length) return [];
    return [{ inputName: input.inputName, rmsDb: toDb(Math.max(...channels.map(channel => channel[0]))), peakDb: toDb(Math.max(...channels.map(channel => channel[1]))) }];
  }) };
}
