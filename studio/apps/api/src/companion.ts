import WebSocket from 'ws';
import type { StudioState } from '@gabin/shared';

export interface CompanionStatus { connected: boolean; syncedProjectId: string | null; error: string | null; }
interface CompanionOptions {
  getState: () => StudioState;
  onStatus: (status: CompanionStatus) => void;
  url?: string;
  /** Shorter values are useful for an isolated fake Companion in tests. */
  intervalMs?: number;
  rpcTimeoutMs?: number;
  reconnectMs?: number;
}
type Values = Record<string, string | number>;
export interface PreviousCompanionBindings { projectId?: string; share?: string; mire?: string; }

const publicName = (name: string) => name === 'nino_project_id' || /^nino_(suite|state)_[a-z0-9_]+$/.test(name);
const validScene = (state: StudioState, value: string | null | undefined) => value && state.obs.scenes.includes(value) ? value : '';

/** No credential is inspected, inferred, created, or replaced by this bridge. */
export function companionBindings(state: StudioState, projectId: string | null, previous: PreviousCompanionBindings = {}): Values {
  const project = state.projects.find(item => item.id === projectId && item.status !== 'archived');
  const values: Values = { nino_project_id: project?.id || '', nino_suite_binding_project_id: project?.id || '' };
  for (let index = 1; index <= 3; index++) values[`nino_suite_camera_${index}`] = validScene(state, project?.participants[index - 1]?.sceneName);
  for (let index = 1; index <= 4; index++) {
    const input = project?.participants[index - 1]?.micInput;
    values[`nino_suite_mic_${index}`] = input && state.obs.inputs.some(item => item.name === input) ? input : '';
  }
  values.nino_suite_wide = project ? validScene(state, state.autoDirectionSettings?.[project.id]?.wideScene) : '';
  // Presentation capture is a room-specific OBS scene, not the PDF/PPT asset.
  // Keep it only when it was explicitly associated with this same production.
  values.nino_suite_share = project && previous.projectId === project.id ? validScene(state, previous.share) : '';
  values.nino_suite_mire = validScene(state, previous.mire);
  const links = project ? state.projectMedia?.[project.id] || [] : [];
  for (const role of ['intro', 'outro', 'logo', 'music'] as const) {
    const candidates = links.filter(link => link.role === role).map(link => state.library?.find(asset => asset.id === link.assetId && !asset.archivedAt))
      .filter(asset => asset && (role === 'logo' ? asset.kind === 'image' : role === 'music' ? asset.kind === 'audio' : ['video', 'image'].includes(asset.kind)));
    // An ambiguous role is deliberately unbound, rather than choosing a file silently.
    values[`nino_suite_asset_${role}`] = candidates.length === 1 ? candidates[0]!.id : '';
  }
  for (const slot of [1, 2]) {
    const guest = project && state.guestRooms?.[project.id]?.guests.find(item => item.slot === slot && item.status !== 'removed');
    values[`nino_suite_guest_${slot}`] = guest ? guest.id : '';
  }
  return values;
}

export function companionFeedback(state: StudioState, projectId: string | null, bindings: Values, now = Date.now()): Values {
  const project = state.projects.find(item => item.id === projectId && item.status !== 'archived');
  const obs = state.obs;
  const obsHealthy = obs.connected && !obs.error;
  const auto = state.autoDirection;
  const launch = state.launch?.projectId === project?.id ? state.launch : undefined;
  const projectConflict = Boolean(
    (state.activeTake && state.activeTake.projectId !== project?.id)
    || (obs.recording && !state.activeTake)
    || (state.liveProjectId && state.liveProjectId !== project?.id && ['starting', 'live', 'stopping'].includes(state.media.liveStatus))
    || (state.launch?.status === 'running' && state.launch.projectId !== project?.id),
  );
  const playback = state.mediaPlayback;
  const values: Values = {
    nino_state_online: 1,
    nino_state_updated_at: Math.floor(now / 1000),
    nino_state_project_id: project?.id || '',
    nino_state_project_title: project?.title || 'Choisir une production',
    nino_state_project_conflict: Number(projectConflict),
    nino_state_obs_connected: Number(obsHealthy),
    nino_state_studio_open_available: Number(state.studioOpenAvailable === true),
    nino_state_recording: Number(obsHealthy && obs.recording),
    nino_state_paused: Number(obsHealthy && obs.recording && obs.paused),
    nino_state_record_timecode: obsHealthy && obs.recording ? obs.timecode.slice(0, 8) : '',
    nino_state_scene: obsHealthy ? obs.currentScene || '' : '',
    nino_state_live_status: state.media.liveStatus,
    nino_state_live_timecode: state.media.liveStatus === 'live' ? state.media.liveTimecode.slice(0, 8) : '',
    nino_state_preview_ready: Number(state.media.previewReady),
    nino_state_auto_status: !obsHealthy ? 'offline' : auto?.projectId === project?.id ? auto?.status || 'off' : 'off',
    nino_state_auto_enabled: Number(obsHealthy && auto?.projectId === project?.id && auto?.enabled),
    nino_state_media_asset: playback?.assetId || '',
    nino_state_media_status: obsHealthy ? playback?.status || 'stopped' : 'unknown',
    nino_state_launch_status: launch?.status || 'idle',
    nino_state_launch_step: launch?.step || '',
    nino_state_launch_message: launch?.message || '',
  };
  for (let index = 1; index <= 4; index++) {
    const input = obs.inputs.find(item => item.name === bindings[`nino_suite_mic_${index}`]);
    values[`nino_state_mic_${index}`] = !obsHealthy || !input || input.muted === null ? 'unknown' : input.muted ? 'muted' : 'open';
  }
  for (const slot of [1, 2]) {
    const guest = project && state.guestRooms?.[project.id]?.guests.find(item => item.slot === slot && item.status !== 'removed');
    values[`nino_state_guest_${slot}`] = guest ? guest.status : 'unconfigured';
    values[`nino_state_guest_${slot}_muted`] = guest && guest.joined ? Number(guest.muted) : 'unknown';
    values[`nino_state_guest_${slot}_scene`] = guest ? guest.sceneName : '';
  }
  return values;
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; }

/** Local, optional state transport. Production commands still use Nino's authenticated API. */
export class CompanionBridge {
  private readonly url: URL;
  private readonly options: CompanionOptions;
  private socket: WebSocket | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private connecting = false;
  private working = false;
  private dirty = false;
  private retryCount = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly known = new Set<string>();
  private readonly sent = new Map<string, string | number>();
  private previous: PreviousCompanionBindings = {};
  private readonly presentationScenes = new Map<string, string>();
  private bindingFingerprint = '';
  private selected: string | null | undefined;
  private status: CompanionStatus = { connected: false, syncedProjectId: null, error: null };

  constructor(options: CompanionOptions) {
    this.options = options;
    this.url = new URL(options.url || process.env.NINO_COMPANION_URL || 'ws://127.0.0.1:8000/trpc');
    if (!['ws:', 'wss:'].includes(this.url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname)
      || this.url.username || this.url.password || this.url.search || this.url.hash || this.url.pathname !== '/trpc') {
      throw new Error('Companion doit être une adresse WebSocket locale terminée par /trpc.');
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.interval = setInterval(() => this.refresh(), this.options.intervalMs ?? 1000);
    this.interval.unref();
    this.connect();
  }

  select(projectId: string | null): void { this.selected = projectId; this.refresh(); }

  refresh(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.socket?.readyState === WebSocket.OPEN && !this.connecting) void this.flush();
  }

  private publish(status: CompanionStatus): void {
    if (JSON.stringify(this.status) === JSON.stringify(status)) return;
    this.status = status;
    this.options.onStatus({ ...status });
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    const httpOrigin = new URL(this.url);
    httpOrigin.protocol = this.url.protocol === 'wss:' ? 'https:' : 'http:';
    const socket = new WebSocket(this.url, { origin: httpOrigin.origin, maxPayload: 64 * 1024 });
    this.socket = socket;
    this.connecting = true;
    this.openTimer = setTimeout(() => socket.terminate(), this.options.rpcTimeoutMs ?? 3000);
    this.openTimer.unref();
    socket.on('error', () => { /* close owns retry and the public, credential-free error */ });
    socket.on('close', () => this.disconnected(socket));
    socket.on('message', raw => {
      if (String(raw) === 'PING') { if (socket.readyState === WebSocket.OPEN) socket.send('PONG'); return; }
      try {
        const parsed = JSON.parse(String(raw));
        for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
          const wait = this.pending.get(message.id);
          if (!wait) continue;
          if (message.error) { this.pending.delete(message.id); clearTimeout(wait.timer); wait.reject(new Error('Companion a refusé la synchronisation.')); }
          else if (message.result?.type === 'data') { this.pending.delete(message.id); clearTimeout(wait.timer); wait.resolve(message.result.data); }
        }
      } catch { socket.terminate(); }
    });
    socket.once('open', () => {
      if (this.openTimer) clearTimeout(this.openTimer);
      this.openTimer = null;
      this.known.clear(); this.sent.clear(); this.bindingFingerprint = '';
      void this.readPrevious().then(previous => {
        if (this.socket !== socket || this.stopped) return;
        this.previous = previous;
        this.connecting = false;
        this.refresh();
      }).catch(() => { if (this.socket === socket) { this.connecting = false; this.refresh(); } });
    });
  }

  private async readPrevious(): Promise<PreviousCompanionBindings> {
    // Read precisely these non-secret values. Never request the custom-variable
    // collection, which also contains the separately paired Nino device credential.
    const base = new URL(this.url); base.protocol = this.url.protocol === 'wss:' ? 'https:' : 'http:';
    const read = async (name: string) => {
      try {
        const response = await fetch(new URL(`/api/custom-variable/${name}/value`, base), { signal: AbortSignal.timeout(this.options.rpcTimeoutMs ?? 3000) });
        if (!response.ok) return '';
        const text = await response.text();
        return text.length <= 300 ? text : '';
      } catch { return ''; }
    };
    const readSceneMap = async () => {
      try {
        const response = await fetch(new URL('/api/custom-variable/nino_suite_presentation_scenes/value', base), { signal: AbortSignal.timeout(this.options.rpcTimeoutMs ?? 3000) });
        const raw = response.ok ? await response.text() : '';
        if (!raw || raw.length > 64 * 1024) return;
        const entries = JSON.parse(raw);
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return;
        for (const [id, scene] of Object.entries(entries).slice(-200)) {
          if (id.length <= 100 && typeof scene === 'string' && scene.length <= 300) this.presentationScenes.set(id, scene);
        }
      } catch { /* This optional public map is absent on older profiles. */ }
    };
    const [armedProjectId, sharedProjectId, share, mire] = await Promise.all([read('nino_suite_binding_project_id'), read('nino_suite_share_project_id'), read('nino_suite_share'), read('nino_suite_mire'), readSceneMap()]);
    // The persistent map is authoritative after a crash during a disarmed sync.
    // Only adopt a legacy standalone scene when its bindings are still armed.
    if (armedProjectId && share && !this.presentationScenes.has(armedProjectId)) this.presentationScenes.set(armedProjectId, share);
    return { projectId: armedProjectId || sharedProjectId, share: armedProjectId ? share : '', mire };
  }

  private previousFor(projectId: string | null): PreviousCompanionBindings {
    return projectId && this.presentationScenes.has(projectId)
      ? { ...this.previous, projectId, share: this.presentationScenes.get(projectId) }
      : this.previous;
  }

  private disconnected(socket: WebSocket): void {
    if (this.socket !== socket) return;
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
    this.socket = null; this.connecting = false;
    for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(new Error('Companion déconnecté.')); }
    this.pending.clear();
    this.publish({ connected: false, syncedProjectId: null, error: this.stopped ? null : 'Companion indisponible sur cet ordinateur.' });
    if (!this.stopped) {
      const delay = Math.min(15_000, (this.options.reconnectMs ?? 1000) * 2 ** Math.min(this.retryCount++, 4));
      this.retry = setTimeout(() => { this.retry = null; this.connect(); }, delay); this.retry.unref();
    }
  }

  private rpc(path: string, input: object): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Companion déconnecté.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Companion ne répond pas.')); }, this.options.rpcTimeoutMs ?? 3000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method: 'mutation', params: { path, input } }));
    });
  }

  private async set(name: string, value: string | number, persist: boolean): Promise<void> {
    if (!publicName(name)) throw new Error('Variable Companion non autorisée.');
    if (!this.known.has(name)) {
      const created = await this.rpc('customVariables.create', { name, defaultVal: '' });
      if (typeof created === 'string' && !created.includes('already exists')) throw new Error('Variable Companion refusée.');
      await this.rpc('customVariables.setPersistence', { name, value: persist });
      this.known.add(name);
    }
    if (this.sent.get(name) === value) return;
    const result = await this.rpc('customVariables.setCurrent', { name, value });
    if (typeof result === 'string' && result) throw new Error('Variable Companion refusée.');
    this.sent.set(name, value);
  }

  private async flush(): Promise<void> {
    if (this.working || !this.socket || this.socket.readyState !== WebSocket.OPEN || this.stopped) return;
    this.working = true;
    try {
      while (this.dirty && !this.stopped && this.socket?.readyState === WebSocket.OPEN) {
        this.dirty = false;
        const state = this.options.getState();
        const selected = this.selected === undefined ? state.streamDeck?.projectId || null : this.selected;
        const bindings = companionBindings(state, selected, this.previousFor(selected));
        const fingerprint = JSON.stringify(bindings);
        if (fingerprint !== this.bindingFingerprint) {
          this.publish({ connected: true, syncedProjectId: null, error: null });
          await this.set('nino_suite_binding_project_id', '', true);
          for (const [name, value] of Object.entries(bindings)) if (name !== 'nino_suite_binding_project_id') {
            if (this.stopped) return;
            await this.set(name, value, true);
          }
          // Recheck after awaited writes: a newly selected production must never be armed
          // with the previous one's camera/media/guest values.
          const current = this.options.getState();
          const currentId = this.selected === undefined ? current.streamDeck?.projectId || null : this.selected;
          if (currentId !== selected || JSON.stringify(companionBindings(current, currentId, this.previousFor(currentId))) !== fingerprint) { this.dirty = true; continue; }
          if (this.stopped) return;
          // Empty OBS inventories during reconnect are unknown, not proof that a
          // room scene was deleted. Preserve the last verified presentation owner.
          if (bindings.nino_project_id && state.obs.connected && !state.obs.error && state.obs.scenes.length) this.presentationScenes.set(String(bindings.nino_project_id), String(bindings.nino_suite_share));
          while (this.presentationScenes.size > 200) this.presentationScenes.delete(this.presentationScenes.keys().next().value!);
          await this.set('nino_suite_presentation_scenes', JSON.stringify(Object.fromEntries(this.presentationScenes)), true);
          await this.set('nino_suite_share_project_id', String(bindings.nino_project_id), true);
          const stillCurrent = () => {
            const latest = this.options.getState();
            const id = this.selected === undefined ? latest.streamDeck?.projectId || null : this.selected;
            return id === selected && JSON.stringify(companionBindings(latest, id, this.previousFor(id))) === fingerprint;
          };
          if (!stillCurrent()) { this.dirty = true; continue; }
          await this.set('nino_suite_binding_project_id', bindings.nino_suite_binding_project_id, true);
          if (!stillCurrent()) { await this.set('nino_suite_binding_project_id', '', true); this.dirty = true; continue; }
          this.bindingFingerprint = fingerprint;
          if (bindings.nino_project_id) this.previous = {
            projectId: String(bindings.nino_project_id),
            share: String(bindings.nino_suite_share),
            mire: state.obs.connected && !state.obs.error && state.obs.scenes.length ? String(bindings.nino_suite_mire) : this.previous.mire,
          };
        }
        for (const [name, value] of Object.entries(companionFeedback(state, selected, bindings))) {
          if (this.stopped) return;
          await this.set(name, value, false);
        }
        if (this.stopped) return;
        this.retryCount = 0;
        this.publish({ connected: true, syncedProjectId: String(bindings.nino_suite_binding_project_id) || null, error: null });
      }
    } catch {
      if (!this.stopped) this.publish({ connected: false, syncedProjectId: null, error: 'Synchronisation Companion interrompue.' });
      this.socket?.terminate();
    } finally { this.working = false; }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    if (this.retry) clearTimeout(this.retry);
    if (this.openTimer) clearTimeout(this.openTimer);
    this.interval = this.retry = this.openTimer = null;
    // Explicitly extinguish feedbacks during a clean shutdown. If the process dies,
    // profile expressions also reject the heartbeat after four seconds.
    if (!this.working && this.socket?.readyState === WebSocket.OPEN) {
      try { await this.set('nino_state_online', 0, false); await this.set('nino_suite_binding_project_id', '', true); } catch { /* bounded RPC timeout */ }
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.terminate();
    for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(new Error('Synchronisation arrêtée.')); }
    this.pending.clear();
    this.publish({ connected: false, syncedProjectId: null, error: null });
  }
}
