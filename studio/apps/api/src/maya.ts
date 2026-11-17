import path from 'node:path';
import WebSocket from 'ws';
import type { CaptureCapability, CaptureState, SceneThumbnail } from '@nino/shared';
import { CaptureUnsupported, emptyCaptureState, type CaptureDriver, type CaptureEvent } from './capture.js';

/** What Maya Studio v0.1 does through the suite protocol. Audio, pause, media
 * playback and browser sources are not in its protocol yet. */
export const mayaCapabilities: readonly CaptureCapability[] = ['record.directory', 'scene.thumbnails', 'stream.local'];

const PROTOCOL_VERSION = 1;
const TIMEOUT_MS = 8000;

interface SuiteResponse { op: 'response'; id: string; ok: boolean; data?: unknown; error?: { code: string; message: string } }
interface SuiteEvent { op: 'event'; app: string; type: string; data?: Record<string, unknown> }
interface OutputStatus { active: boolean; target?: string; duration_s?: number }
interface SceneList { scenes: { id: string; name: string }[]; program_scene: string }

export class MayaRequestFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function msTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor(total / 60_000) % 60)}:${pad(Math.floor(total / 1000) % 60)}.${pad(total % 1000, 3)}`;
}

/** Maya Studio driver, through the Suite Media protocol v1 (docs/protocole-suite.md
 * of maya-studio). Like the OBS driver, every command is confirmed by a fresh read. */
export class MayaStudioDriver implements CaptureDriver {
  readonly software = 'maya' as const;
  readonly capabilities = mayaCapabilities;
  private socket: WebSocket | null = null;
  private state: CaptureState = emptyCaptureState();
  private readonly listeners = new Set<(event: CaptureEvent) => void>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private epoch = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<CaptureState> | null = null;
  private recordDirectory: string | null = null;
  private feedUrl: string | null = null;
  private recordTarget: string | null = null;

  constructor(private readonly options: { clientName?: string; version?: string } = {}) {}

  getState(): CaptureState { return structuredClone(this.state); }
  subscribe(listener: (event: CaptureEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: CaptureEvent): void { for (const listener of this.listeners) listener(event); }
  private publish(): void { this.emit({ type: 'state', state: this.getState() }); }

  async connect(url: string, token: string): Promise<CaptureState> {
    if (this.socket) await this.disconnect();
    const epoch = ++this.epoch;
    this.state = { ...this.state, connecting: true, error: null };
    this.publish();
    try {
      await this.open(url, token, epoch);
      this.state = { ...this.state, connected: true, connecting: false, error: null, recordingDirectory: this.recordDirectory };
      await this.refresh(true);
      this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, 1000);
      this.timer.unref();
      return this.getState();
    } catch (error) {
      this.closeSocket();
      this.state = { ...this.state, connected: false, connecting: false,
        error: error instanceof MayaRequestFailure && error.code === 'auth_failed' ? 'Maya Studio a refusé le jeton. Vérifiez le jeton de la suite.'
          : 'Connexion à Maya Studio refusée. Vérifiez qu’il tourne sur ce PC et son adresse.' };
      this.publish();
      throw new Error(this.state.error!);
    }
  }

  private open(url: string, token: string, epoch: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: TIMEOUT_MS });
      this.socket = socket;
      let identified = false;
      const fail = (error: Error) => { clearTimeout(timer); if (!identified) reject(error); };
      const timer = setTimeout(() => { fail(new Error('timeout')); socket.terminate(); }, TIMEOUT_MS);
      timer.unref();
      socket.on('message', (raw) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(String(raw)); } catch { return; }
        if (message.op === 'hello') {
          const app = message.app as { id?: string } | undefined;
          if (message.protocol !== PROTOCOL_VERSION || app?.id !== 'studio') { fail(new MayaRequestFailure('protocol', 'Version du protocole incompatible.')); socket.close(); return; }
          socket.send(JSON.stringify({ op: 'identify', token: token || undefined, name: this.options.clientName ?? 'Nino',
            app: { id: 'nino', name: 'Nino', version: this.options.version ?? '0.1.0' }, events: true }));
        } else if (message.op === 'identified') {
          identified = true; clearTimeout(timer); resolve();
        } else if (message.op === 'response') {
          const response = message as unknown as SuiteResponse;
          if (!identified && response.error?.code === 'auth_failed') { fail(new MayaRequestFailure('auth_failed', response.error.message)); return; }
          const entry = this.pending.get(response.id);
          if (!entry) return;
          this.pending.delete(response.id); clearTimeout(entry.timer);
          if (response.ok) entry.resolve(response.data ?? {});
          else entry.reject(new MayaRequestFailure(response.error?.code ?? 'unknown', response.error?.message ?? 'Erreur Maya Studio.'));
        } else if (message.op === 'event' && epoch === this.epoch) {
          this.onEvent(message as unknown as SuiteEvent);
        }
      });
      socket.on('error', () => fail(new Error('socket')));
      socket.on('close', () => {
        fail(new Error('closed'));
        if (this.socket !== socket) return;
        this.lost('Connexion à Maya Studio interrompue. État de l’enregistrement à vérifier dans Maya Studio.');
      });
    });
  }

  private onEvent(event: SuiteEvent): void {
    if (event.type === 'OutputStopped' && event.data?.output === 'record') {
      const target = typeof event.data.target === 'string' ? event.data.target : this.recordTarget;
      const duration = typeof event.data.duration_s === 'number' ? event.data.duration_s * 1000 : 0;
      this.emit({ type: 'recordStopped', outputPath: target, durationMs: Math.round(duration) });
    }
    void this.refresh().catch(() => undefined);
  }

  /** A lost link never means stopped: keep the last known outputs, flag the error. */
  private lost(error: string): void {
    this.epoch++;
    this.stopPolling();
    this.closeSocket();
    this.state = { ...this.state, connected: false, connecting: false, error };
    this.emit({ type: 'disconnected' });
    this.publish();
  }
  private stopPolling(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new Error('closed')); this.pending.delete(id); }
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
  }

  private request<T>(type: string, data?: Record<string, unknown>): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Maya Studio n’est pas connecté.'));
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Délai de réponse Maya Studio dépassé.'));
        this.lost('Maya Studio ne répond plus. Vérifiez son état puis reconnectez, aucune commande ne sera rejouée.');
      }, TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ op: 'request', id, type, ...(data ? { data } : {}) }));
    });
  }

  async disconnect(): Promise<void> {
    this.epoch++;
    this.stopPolling();
    this.closeSocket();
    this.state = { ...this.state, connected: false, connecting: false, error: null };
    this.publish();
  }

  async refresh(fresh = false): Promise<CaptureState> {
    if (fresh) while (this.refreshInFlight) await this.refreshInFlight.catch(() => undefined);
    if (!this.state.connected) return this.getState();
    if (this.refreshInFlight) return this.refreshInFlight;
    const promise = this.readState(this.epoch).finally(() => { if (this.refreshInFlight === promise) this.refreshInFlight = null; });
    this.refreshInFlight = promise;
    return promise;
  }

  private async readState(epoch: number): Promise<CaptureState> {
    const [list, outputs] = await Promise.all([this.request<SceneList>('GetSceneList'), this.request<{ record: OutputStatus; stream: OutputStatus }>('GetOutputStatus')]);
    if (epoch !== this.epoch) return this.getState();
    const record = outputs.record ?? { active: false };
    const stream = outputs.stream ?? { active: false };
    if (record.active && record.target) this.recordTarget = record.target;
    this.state = { ...this.state, connected: true, error: null,
      scenes: list.scenes.map(scene => scene.name),
      currentScene: list.scenes.find(scene => scene.id === list.program_scene)?.name ?? null,
      inputs: [],
      recording: record.active, paused: false,
      timecode: msTimecode(record.active ? (record.duration_s ?? 0) * 1000 : 0),
      recordingDirectory: this.recordDirectory, outputBytes: 0,
      streaming: stream.active, streamReconnecting: false,
      streamTimecode: msTimecode(stream.active ? (stream.duration_s ?? 0) * 1000 : 0), streamOutputBytes: 0 };
    this.publish();
    return this.getState();
  }

  async sceneThumbnail(sceneName: string): Promise<SceneThumbnail> {
    const unavailable: SceneThumbnail = { sceneName, imageData: null, capturedAt: null, available: false };
    if (!this.state.connected || !this.state.scenes.includes(sceneName)) return unavailable;
    try {
      const { image } = await this.request<{ image?: string }>('GetScreenshot', { scene: sceneName, format: 'jpeg' });
      return typeof image === 'string' && image.startsWith('data:image/') ? { sceneName, imageData: image, capturedAt: new Date().toISOString(), available: true } : unavailable;
    } catch { return unavailable; }
  }

  async setScene(sceneName: string): Promise<void> { await this.request('SetProgramScene', { scene: sceneName }); }
  async setInputMute(): Promise<void> { throw new CaptureUnsupported('Maya Studio ne gère pas encore les micros.'); }
  async pauseRecord(): Promise<void> { throw new CaptureUnsupported('Maya Studio ne permet pas encore la pause.'); }
  async resumeRecord(): Promise<void> { throw new CaptureUnsupported('Maya Studio ne permet pas encore la pause.'); }

  /** Maya records to a file path chosen per take; the directory is kept here. */
  async setRecordDirectory(directory: string): Promise<void> {
    if (!path.isAbsolute(directory)) throw new Error('Le dossier d’enregistrement doit être absolu.');
    this.recordDirectory = directory;
    this.state = { ...this.state, recordingDirectory: directory };
    this.publish();
  }
  async startRecord(): Promise<void> {
    if (!this.recordDirectory) throw new Error('Aucun dossier d’enregistrement choisi.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.recordDirectory, `nino-${stamp}.mp4`);
    this.recordTarget = target;
    await this.request('StartRecording', { path: target });
  }
  async stopRecord(): Promise<{ outputPath: string | null }> {
    const result = await this.request<{ target?: string }>('StopRecording');
    return { outputPath: typeof result.target === 'string' ? result.target : this.recordTarget };
  }

  /** The local programme feed (MediaMTX) as one RTMP URL, like OBS's custom service. */
  async configureLocalFeed(settings: { server: string; key: string }): Promise<void> {
    this.feedUrl = `${settings.server.replace(/\/+$/, '')}/${settings.key.replace(/^\/+/, '')}`;
  }
  async startStream(): Promise<void> {
    if (!this.feedUrl) throw new Error('Le retour local n’est pas configuré.');
    await this.request('StartStream', { url: this.feedUrl });
  }
  async stopStream(): Promise<void> { await this.request('StopStream'); }
}
