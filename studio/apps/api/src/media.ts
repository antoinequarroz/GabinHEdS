import type { MediaState } from '@gabin/shared';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface PrivateLiveDestination { name: string; server: string; key: string; }
export interface MediaGateway {
  getState(): MediaState;
  refresh(): Promise<MediaState>;
  ingestSettings(): { server: string; key: string };
  startLive(destination: PrivateLiveDestination): Promise<void>;
  stopLive(): Promise<void>;
  hlsResource(resource: string): Promise<Response>;
  subscribe(listener: (state: MediaState) => void): () => void;
  close(): Promise<void>;
}

export function emptyMediaState(): MediaState {
  return { available: false, previewReady: false, previewError: null, liveStatus: 'idle', liveError: null,
    liveTimecode: '00:00:00.000', liveBytes: 0, liveDestination: null };
}

/** Only same-directory HLS files and MediaMTX's single session identifier may
 * cross the authenticated proxy. No arbitrary URL, query or filesystem path. */
export function validHlsResource(resource: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.(?:m3u8|ts|mp4|m4s)(?:\?session=[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})?$/.test(resource)
    && !resource.includes('..');
}

export interface MediaOptions {
  apiUrl?: string;
  hlsUrl?: string;
  rtspUrl?: string;
  rtmpUrl?: string;
  path?: string;
  ffmpegPath?: string;
  pollIntervalMs?: number;
}

function localUrl(value: string, protocols: string[]): string {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Les services média doivent être locaux au PC de la salle.');
  }
  return `${url.protocol}//${url.host}`;
}

/** OBS publishes locally. HLS carries real H264/AAC; the relay sends the same
 * programme to the live destination. Browser controls never own these jobs. */
export class RealMediaGateway implements MediaGateway {
  private state = emptyMediaState();
  private readonly listeners = new Set<(state: MediaState) => void>();
  private readonly apiUrl: string;
  private readonly hlsUrl: string;
  private readonly rtspUrl: string;
  private readonly rtmpUrl: string;
  private readonly path: string;
  private readonly ffmpeg: string;
  private readonly timer: ReturnType<typeof setInterval>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private expectedExit = false;
  private closed = false;
  private refreshing: Promise<MediaState> | null = null;

  constructor(options: MediaOptions = {}) {
    this.apiUrl = localUrl(options.apiUrl ?? process.env.GABIN_MEDIA_API_URL ?? 'http://127.0.0.1:9997', ['http:']);
    this.hlsUrl = localUrl(options.hlsUrl ?? process.env.GABIN_MEDIA_HLS_URL ?? 'http://127.0.0.1:8888', ['http:']);
    this.rtspUrl = localUrl(options.rtspUrl ?? process.env.GABIN_MEDIA_RTSP_URL ?? 'rtsp://127.0.0.1:8554', ['rtsp:']);
    this.rtmpUrl = localUrl(options.rtmpUrl ?? process.env.GABIN_MEDIA_RTMP_URL ?? 'rtmp://127.0.0.1:1935', ['rtmp:']);
    this.path = options.path ?? process.env.GABIN_MEDIA_PATH ?? 'gabin/program';
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(this.path)) throw new Error('Chemin média invalide.');
    this.ffmpeg = options.ffmpegPath ?? process.env.GABIN_FFMPEG_PATH
      ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
    this.timer = setInterval(() => { void this.refresh(); }, options.pollIntervalMs ?? 1500);
    this.timer.unref();
    void this.refresh();
  }
  getState(): MediaState { return structuredClone(this.state); }
  subscribe(listener: (state: MediaState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(update: Partial<MediaState>): void {
    const next = { ...this.state, ...update };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    if (!this.closed) for (const listener of this.listeners) listener(this.getState());
  }
  ingestSettings(): { server: string; key: string } {
    const parts = this.path.split('/');
    const key = parts.pop()!;
    return { server: `${this.rtmpUrl}/${parts.join('/')}`, key };
  }
  refresh(): Promise<MediaState> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.readState().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  private async readState(): Promise<MediaState> {
    try {
      const response = await fetch(`${this.apiUrl}/v3/paths/list`, { signal: AbortSignal.timeout(2500) });
      if (!response.ok) throw new Error('Media server unavailable');
      const data = await response.json() as { items?: { name: string; ready: boolean }[] };
      const ready = Boolean(data.items?.some(item => item.name === this.path && item.ready));
      this.changed({ available: true, previewReady: ready, previewError: null });
    } catch {
      this.changed({ available: false, previewReady: false,
        previewError: 'Le relais vidéo local ne répond pas. Lancez MediaMTX sur le PC de la salle.' });
    }
    return this.getState();
  }
  async hlsResource(resource: string): Promise<Response> {
    if (!validHlsResource(resource)) throw new Error('Ressource média invalide.');
    const initial = new URL(`${this.hlsUrl}/${this.path}/${resource}`);
    let url = initial;
    const signal = AbortSignal.timeout(12000);
    for (let redirects = 0; ; redirects++) {
      const response = await fetch(url, { signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects >= 2) throw new Error('Redirection média non autorisée.');
      const next = new URL(location, url);
      // MediaMTX checks cookie support before using UUID sessions in relative
      // playlist URIs. This handshake stays internal to the local proxy.
      const hlsReference = `${next.pathname.slice(next.pathname.lastIndexOf('/') + 1)}${next.search}`;
      const cookieHandshake = initial.pathname.endsWith('.m3u8') && next.search === '?cookieCheck=1';
      if (next.origin !== initial.origin || next.pathname !== initial.pathname || next.username || next.password || next.hash
        || !(validHlsResource(hlsReference) || cookieHandshake)) {
        throw new Error('Redirection média non autorisée.');
      }
      url = next;
    }
  }
  async startLive(destination: PrivateLiveDestination): Promise<void> {
    if (this.child || this.state.liveStatus === 'starting' || this.state.liveStatus === 'stopping') throw new Error('Une diffusion est déjà en cours.');
    const target = new URL(destination.server);
    if (!['rtmp:', 'rtmps:'].includes(target.protocol) || !target.hostname || target.username || target.password || target.search || target.hash || /[\r\n\0]/.test(destination.key)) {
      throw new Error('La destination doit être un serveur RTMP ou RTMPS valide.');
    }
    const output = `${destination.server.replace(/\/+$/, '')}/${destination.key.replace(/^\/+/, '')}`;
    this.changed({ liveStatus: 'starting', liveError: null, liveTimecode: '00:00:00.000', liveBytes: 0, liveDestination: destination.name });
    // Wait for real packets from OBS; a WebSocket StartStream ACK alone is not
    // proof of a programme that can be relayed.
    const deadline = Date.now() + 18000;
    while (!(await this.refresh()).previewReady) {
      if (!this.state.available || Date.now() >= deadline) {
        this.changed({ liveStatus: 'error', liveError: 'Le programme OBS n’arrive pas au relais local. Vérifiez la sortie vidéo H264/AAC dans OBS.' });
        throw new Error(this.state.liveError!);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    this.expectedExit = false;
    const child = spawn(this.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats',
      '-rtsp_transport', 'tcp', '-timeout', '8000000', '-i', `${this.rtspUrl}/${this.path}`,
      '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'flv', '-flvflags', 'no_duration_filesize',
      '-rw_timeout', '8000000', '-progress', 'pipe:1', output], { windowsHide: true });
    this.child = child;
    // Do not expose FFmpeg stderr: it can contain the full private stream URL.
    child.stderr.resume();
    let buffer = '';
    const progress: Record<string, string> = {};
    let startupSettled = false;
    let resolveStart!: () => void;
    let rejectStart!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    const failStart = (message: string) => {
      if (!startupSettled) { startupSettled = true; rejectStart(new Error(message)); }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        const equals = line.indexOf('=');
        if (equals < 0) continue;
        const key = line.slice(0, equals), value = line.slice(equals + 1);
        progress[key] = value;
        if (key !== 'progress') continue;
        const bytes = Number(progress.total_size);
        const time = progress.out_time ?? '';
        const positiveDuration = Number(progress.out_time_us ?? progress.out_time_ms) > 0;
        if (this.state.liveStatus === 'starting' && positiveDuration) {
          this.changed({ liveStatus: 'live', liveError: null });
          if (!startupSettled) { startupSettled = true; resolveStart(); }
        }
        this.changed({ liveTimecode: /^\d+:\d+:\d+\.\d+$/.test(time) ? time.slice(0, time.indexOf('.') + 4) : this.state.liveTimecode,
          liveBytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : this.state.liveBytes });
      }
      if (buffer.length > 8192) buffer = '';
    });
    child.once('error', () => {
      if (this.child !== child) return;
      this.child = null;
      const message = 'Impossible de lancer le relais de diffusion. Vérifiez l’installation de FFmpeg sur le PC.';
      this.changed({ liveStatus: 'error', liveError: message });
      failStart(message);
    });
    child.once('close', () => {
      if (this.child !== child) return;
      this.child = null;
      if (this.expectedExit) this.changed({ liveStatus: 'idle', liveError: null });
      else {
        const message = 'La diffusion a été interrompue. Vérifiez la destination, sa clé et la connexion Internet avant de relancer.';
        this.changed({ liveStatus: 'error', liveError: message });
        failStart(message);
      }
    });
    const timeout = setTimeout(() => {
      if (!startupSettled) {
        const message = 'La destination n’a pas confirmé l’envoi du programme. Vérifiez son adresse et sa clé.';
        failStart(message);
        this.changed({ liveStatus: 'error', liveError: message });
        child.kill('SIGTERM');
      }
    }, 18000);
    try { await started; }
    finally { clearTimeout(timeout); }
  }
  async stopLive(): Promise<void> {
    const child = this.child;
    if (!child) { this.changed({ liveStatus: 'idle', liveError: null }); return; }
    this.expectedExit = true;
    this.changed({ liveStatus: 'stopping' });
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill('SIGINT');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 4000); })]);
    clearTimeout(timer);
    if (this.child === child) {
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
    }
    if (this.child === child) throw new Error('Le relais n’a pas confirmé son arrêt. Vérifiez le PC de la salle.');
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.stopLive();
    this.listeners.clear();
  }
}
