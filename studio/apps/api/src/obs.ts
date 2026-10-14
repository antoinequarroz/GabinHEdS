import OBSWebSocket, { EventSubscription, type OBSRequestTypes, type OBSResponseTypes } from 'obs-websocket-js/json';
import type { AudioFrame, ObsState, SceneThumbnail } from '@gabin/shared';

export type ObsEvent =
  | { type: 'state'; state: ObsState }
  | { type: 'recordStopped'; outputPath: string | null; durationMs: number }
  | { type: 'audio'; frame: AudioFrame }
  | { type: 'disconnected' };
export class ObsFeedConflict extends Error {}

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

  constructor() {
    this.client.on('ConnectionClosed', () => {
      this.connectionEpoch++;
      this.stopPolling();
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
