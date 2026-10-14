import { computed, ref, shallowRef } from 'vue';
import type {
  AudioFrame, AuthResult, ClientMessage, ControlCommand, Device, DownloadTicket, PairingCode, Preparation,
  PreviewSession, Project, ProjectInput, RoomConfig, RoomConfigInput, SceneThumbnail, ServerMessage, StudioState,
} from '@gabin/shared';

const tokenKey = 'gabin.studio.device';
const token = ref(localStorage.getItem(tokenKey) ?? '');
const device = shallowRef<Device | null>(null);
const state = shallowRef<StudioState | null>(null);
const initialized = ref(false);
const live = ref(false);
const audioFrame = shallowRef<AudioFrame | null>(null);
const audioReceivedAt = ref(0);
const error = ref('');
const notice = ref('');
const busy = ref<Record<string, boolean>>({});
const canEdit = computed(() => device.value?.role === 'technician' || device.value?.role === 'operator');
const technician = computed(() => device.value?.role === 'technician');
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 1000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('offline', () => { live.value = false; socket?.close(); });
window.addEventListener('online', () => { if (token.value) connectEvents(); });

class ApiFailure extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function newId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30000);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init, signal: abort.signal,
      headers: { 'Content-Type': 'application/json', ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}), ...init.headers },
    });
  } catch {
    live.value = false;
    socket?.close();
    throw new Error(path === '/control'
      ? 'La confirmation du studio n’est pas arrivée. Vérifiez l’état dans OBS avant de réessayer ; la commande a pu être reçue par le PC.'
      : 'Le PC de la salle ne répond pas. Vérifiez sa connexion et le serveur Nino.');
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 401 && token.value) forgetDevice();
    throw new ApiFailure(body.error ?? `Le serveur a refusé la demande (${response.status}).`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function applyState(next: StudioState): void {
  if (!state.value || next.revision >= state.value.revision) state.value = next;
}

function notify(message: string): void {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = ''; }, 6000);
}

async function run<T>(key: string, operation: () => Promise<T>): Promise<T | undefined> {
  if (busy.value[key]) return undefined;
  busy.value = { ...busy.value, [key]: true };
  error.value = '';
  try { return await operation(); }
  catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'La demande n’a pas pu aboutir.';
    return undefined;
  } finally { busy.value = { ...busy.value, [key]: false }; }
}

function stopEvents(): void {
  clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
  live.value = false;
  audioFrame.value = null;
}

function forgetDevice(): void {
  token.value = '';
  localStorage.removeItem(tokenKey);
  device.value = null;
  state.value = null;
  stopEvents();
}

function connectEvents(): void {
  if (!token.value || socket) return;
  const connection = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/events`);
  let firstSnapshot = true;
  socket = connection;
  connection.onopen = () => {
    if (socket !== connection || !token.value) return;
    connection.send(JSON.stringify({ type: 'auth', token: token.value } satisfies ClientMessage));
  };
  connection.onmessage = event => {
    if (socket !== connection || !token.value) return;
    try {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (message.type === 'state') {
        if (firstSnapshot) state.value = message.state;
        else applyState(message.state);
        firstSnapshot = false;
        live.value = true;
        reconnectDelay = 1000;
      } else if (message.type === 'audio') {
        audioFrame.value = message.frame;
        audioReceivedAt.value = performance.now();
      } else if (message.type === 'error') {
        error.value = message.error;
        live.value = false;
      }
    } catch { live.value = false; error.value = 'La mise à jour du studio est illisible. Reconnexion en cours.'; }
  };
  connection.onclose = event => {
    if (socket !== connection) return;
    socket = null;
    live.value = false;
    audioFrame.value = null;
    if (event.code === 4001) {
      forgetDevice();
      error.value = 'L’accès de cet appareil est révoqué ou expiré. Associez-le à nouveau depuis le PC.';
      return;
    }
    if (token.value) {
      reconnectTimer = setTimeout(connectEvents, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    }
  };
  connection.onerror = () => { live.value = false; };
}

async function acceptAuth(result: AuthResult): Promise<void> {
  token.value = result.token;
  localStorage.setItem(tokenKey, result.token);
  device.value = result.device;
  state.value = await api<StudioState>('/state');
  connectEvents();
}

async function initialize(): Promise<void> {
  if (initialized.value) return;
  await run('auth', async () => {
    if (token.value) {
      device.value = await api<Device>('/auth/me');
      state.value = await api<StudioState>('/state');
      connectEvents();
    } else if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
      await acceptAuth(await api<AuthResult>('/auth/local', { method: 'POST', body: JSON.stringify({ name: 'PC de la salle' }) }));
    }
  });
  initialized.value = true;
}

async function pair(code: string, name: string): Promise<boolean> {
  return (await run('auth', async () => {
    await acceptAuth(await api<AuthResult>('/auth/pair', { method: 'POST', body: JSON.stringify({ code, name, kind: 'ipad' }) }));
    return true;
  })) ?? false;
}

async function saveProject(input: ProjectInput, id?: string): Promise<Project | undefined> {
  return run('project', async () => {
    const project = await api<Project>(id ? `/projects/${encodeURIComponent(id)}` : '/projects', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(input) });
    applyState(await api<StudioState>('/state'));
    notify(id ? 'Projet enregistré.' : 'Projet créé. Préparez maintenant la salle.');
    return project;
  });
}

async function preparation(projectId: string): Promise<Preparation | undefined> {
  return run(`preparation:${projectId}`, () => api<Preparation>(`/preparation/${encodeURIComponent(projectId)}`));
}

type WithoutRequestId<Command> = Command extends unknown ? Omit<Command, 'requestId'> : never;
async function control(command: WithoutRequestId<ControlCommand>): Promise<boolean> {
  if (!live.value || !canEdit.value) return false;
  return (await run('control', async () => {
    applyState(await api<StudioState>('/control', { method: 'POST', body: JSON.stringify({ ...command, requestId: newId() }) }));
    return true;
  })) ?? false;
}

async function connectObs(disconnect = false): Promise<boolean> {
  return (await run('obs', async () => {
    applyState(await api<StudioState>(`/obs/${disconnect ? 'disconnect' : 'connect'}`, { method: 'POST', body: '{}' }));
    return true;
  })) ?? false;
}

async function saveRoom(input: RoomConfigInput): Promise<RoomConfig | undefined> {
  return run('room', async () => {
    const room = await api<RoomConfig>('/room', { method: 'PATCH', body: JSON.stringify(input) });
    applyState(await api<StudioState>('/state'));
    notify('Configuration de la salle enregistrée.');
    return room;
  });
}

async function downloadTake(id: string): Promise<void> {
  await run(`download:${id}`, async () => {
    const ticket = await api<DownloadTicket>(`/takes/${encodeURIComponent(id)}/download-ticket`, { method: 'POST', body: '{}' });
    const url = new URL(ticket.url, location.origin);
    if (url.origin !== location.origin || !/^\/api\/downloads\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      throw new Error('Le lien de téléchargement du studio est invalide.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url.href, { method: 'HEAD', signal: controller.signal });
      if (!response.ok) throw new Error('Le fichier n’est plus disponible ou le lien a expiré. Vérifiez le fichier sur le PC, puis réessayez.');
    } finally { clearTimeout(timer); }
    const anchor = document.createElement('a');
    anchor.href = url.href;
    anchor.download = '';
    anchor.rel = 'noreferrer';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    notify('Le navigateur prend en charge le téléchargement du fichier.');
  });
}

// Optional images use the same device access as every studio request. An
// unavailable thumbnail must never suspend recording or the control socket.
async function thumbnailResponse(path: string): Promise<Response | null> {
  if (!token.value) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14_000);
  const requestToken = token.value;
  try {
    const response = await fetch(`/api${path}`, { signal: controller.signal, headers: { Authorization: `Bearer ${requestToken}` } });
    if (response.status === 401 && token.value === requestToken) forgetDevice();
    return response.ok && token.value === requestToken ? response : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function sceneThumbnail(scene: string): Promise<SceneThumbnail | null> {
  const response = await thumbnailResponse(`/obs/scenes/thumbnail?name=${encodeURIComponent(scene)}`);
  if (!response) return null;
  try { return await response.json() as SceneThumbnail; } catch { return null; }
}

async function takeThumbnail(id: string): Promise<string | null> {
  const response = await thumbnailResponse(`/takes/${encodeURIComponent(id)}/thumbnail`);
  if (!response || response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg') return null;
  const blob = await response.blob();
  if (blob.size > 1024 * 1024) return null;
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

export function useStudio() {
  return {
    device, state, initialized, live, audioFrame, audioReceivedAt, error, notice, busy, canEdit, technician,
    initialize, pair, forgetDevice, saveProject, preparation, control, connectObs, saveRoom, downloadTake, sceneThumbnail, takeThumbnail,
    getDevices: () => run('devices', () => api<Device[]>('/devices')),
    createPairing: (role: Device['role'] = 'operator') => run('pairing', () => api<PairingCode>('/pairing', { method: 'POST', body: JSON.stringify({ role, kind: 'ipad' }) })),
    createStreamDeck: (name: string) => run('streamdeck', () => api<AuthResult>('/devices', { method: 'POST', body: JSON.stringify({ name, kind: 'streamdeck', role: 'operator' }) })),
    revokeDevice: (id: string) => run('revoke', async () => { await api<void>(`/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }); notify('Accès de l’appareil révoqué.'); return true; }),
    refresh: () => run('refresh', async () => { applyState(await api<StudioState>('/state')); }),
    previewSession: () => run('preview-session', () => api<PreviewSession>('/monitor/session', { method: 'POST', body: '{}' })),
  };
}
