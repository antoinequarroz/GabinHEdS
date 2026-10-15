import { computed, ref, shallowRef } from 'vue';
import type {
  AudioFrame, AuthResult, ClientMessage, ControlCommand, Device, DownloadTicket, PairingCode, Preparation,
  PreviewSession, Project, ProjectInput, RoomConfig, RoomConfigInput, SceneThumbnail, ServerMessage, StudioState,
  MediaAsset, ProjectMediaLink, FilePlaybackSession, TakePlaybackStatus, TakeMp4DownloadStatus, ResolveExportStatus, GuestInvitation, GuestSession,
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
let controllerEnabled = false;
const resolvePreparations = new Map<string, AbortController>();
const mp4Preparations = new Map<string, AbortController>();
const guestInvitations = shallowRef<Record<string, Record<number, GuestInvitation>>>({});
window.addEventListener('offline', () => { live.value = false; socket?.close(); });
window.addEventListener('online', () => { if (controllerEnabled && token.value) connectEvents(); });

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
  const cancel = () => abort.abort();
  init.signal?.addEventListener('abort', cancel, { once: true });
  if (init.signal?.aborted) abort.abort();
  const timer = setTimeout(() => abort.abort(), 30000);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init, signal: abort.signal,
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}), ...init.headers },
    });
  } catch {
    if (init.signal?.aborted) throw new DOMException('Demande interrompue.', 'AbortError');
    live.value = false;
    socket?.close();
    throw new Error(path === '/control'
      ? 'La confirmation du studio n’est pas arrivée. Vérifiez l’état dans OBS avant de réessayer ; la commande a pu être reçue par le PC.'
      : 'Le PC de la salle ne répond pas. Vérifiez sa connexion et le serveur Nino.');
  } finally { clearTimeout(timer); init.signal?.removeEventListener('abort', cancel); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 401 && token.value) forgetDevice();
    throw new ApiFailure(body.error ?? `Le serveur a refusé la demande (${response.status}).`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function applyState(next: StudioState): void {
  if (!state.value || next.revision >= state.value.revision) {
    state.value = next;
    const active = new Set(Object.values(next.guestRooms ?? {}).flatMap(room => room.guests.filter(guest => guest.status === 'invited').map(guest => guest.id)));
    let changed = false; const invitations: Record<string, Record<number, GuestInvitation>> = {};
    for (const [projectId, links] of Object.entries(guestInvitations.value)) {
      invitations[projectId] = {};
      for (const [slot, invitation] of Object.entries(links)) { if (active.has(invitation.guestId)) invitations[projectId][Number(slot)] = invitation; else changed = true; }
    }
    if (changed) guestInvitations.value = invitations;
  }
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
  for (const controller of resolvePreparations.values()) controller.abort();
  for (const controller of mp4Preparations.values()) controller.abort();
  token.value = '';
  localStorage.removeItem(tokenKey);
  device.value = null;
  state.value = null;
  guestInvitations.value = {};
  stopEvents();
}

function connectEvents(): void {
  if (!controllerEnabled || !token.value || socket) return;
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
  controllerEnabled = true;
  if (initialized.value) { if (token.value && device.value) connectEvents(); return; }
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

async function uploadMedia(file: File, title?: string, onProgress?: (percent: number) => void): Promise<MediaAsset | undefined> {
  return run('media-upload', async () => {
    if (!canEdit.value) throw new Error('Cet appareil ne peut pas ajouter de médias.');
    if (file.size > 1024 ** 3) throw new Error('Choisissez un fichier de 1 Go maximum.');
    if (!file.size) throw new Error('Ce fichier est vide.');
    const requestToken = token.value;
    const asset = await new Promise<MediaAsset>((resolve, reject) => {
      const form = new FormData();
      if (title?.trim()) form.append('title', title.trim());
      form.append('file', file, file.name);
      const request = new XMLHttpRequest();
      request.open('POST', '/api/library');
      request.timeout = 30 * 60_000;
      request.setRequestHeader('Authorization', `Bearer ${requestToken}`);
      request.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(Math.min(99, Math.round(event.loaded / event.total * 100))); };
      request.upload.onload = () => onProgress?.(100);
      request.onerror = () => reject(new Error('L’import a été interrompu. Vérifiez la connexion au PC, puis réessayez.'));
      request.ontimeout = () => reject(new Error('L’import est trop long. Vérifiez la connexion au PC avant de réessayer.'));
      request.onabort = () => reject(new Error('L’import a été interrompu.'));
      request.onload = () => {
        let body: MediaAsset & { error?: string };
        try { body = JSON.parse(request.responseText); }
        catch { reject(new Error('Le PC n’a pas confirmé l’import. Actualisez la bibliothèque avant de réessayer.')); return; }
        if (request.status === 401 && token.value === requestToken) forgetDevice();
        if (request.status < 200 || request.status >= 300) { reject(new Error(body.error ?? 'Ce média n’a pas pu être importé.')); return; }
        if (token.value !== requestToken) { reject(new Error('L’accès de cet appareil a changé pendant l’import.')); return; }
        onProgress?.(100);
        resolve(body);
      };
      request.send(form);
    });
    applyState(await api<StudioState>('/state'));
    notify('Média ajouté à la bibliothèque.');
    return asset;
  });
}

async function updateMedia(id: string, input: { title?: string; archived?: boolean }): Promise<MediaAsset | undefined> {
  return run(`media-edit:${id}`, async () => {
    const asset = await api<MediaAsset>(`/library/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
    applyState(await api<StudioState>('/state'));
    notify(input.archived === true ? 'Média archivé. Il reste conservé pour les productions existantes.' : input.archived === false ? 'Média restauré.' : 'Nom du média enregistré.');
    return asset;
  });
}

async function saveProjectMedia(projectId: string, links: ProjectMediaLink[]): Promise<ProjectMediaLink[] | undefined> {
  return run(`project-media:${projectId}`, async () => {
    const saved = await api<ProjectMediaLink[]>(`/projects/${encodeURIComponent(projectId)}/media`, { method: 'PUT', body: JSON.stringify({ links }) });
    applyState(await api<StudioState>('/state'));
    notify('Médias de la production enregistrés.');
    return saved;
  });
}

function safeSession<T extends { url: string }>(session: T, prefix: string): T {
  const url = new URL(session.url, location.origin);
  const hasCredentials = url.username.length + url.password.length > 0;
  const validPath = new RegExp(`^/api/${prefix}/[A-Za-z0-9_-]{43}$`).test(url.pathname);
  if (url.origin !== location.origin || hasCredentials || !validPath || url.search || url.hash) {
    throw new Error('Le lien transmis par le studio est invalide.');
  }
  return session;
}

function cancelTakeMp4Download(id: string): void { mp4Preparations.get(id)?.abort(); }

async function downloadTakeMp4(id: string): Promise<void> {
  await run(`mp4-download:${id}`, async () => {
    const controller = new AbortController();
    mp4Preparations.set(id, controller);
    const deadline = Date.now() + 30 * 60_000;
    const timer = setTimeout(() => controller.abort(), 30 * 60_000);
    try {
      while (Date.now() < deadline) {
        const result = await api<TakeMp4DownloadStatus>(`/takes/${encodeURIComponent(id)}/mp4-download-ticket`, { method: 'POST', signal: controller.signal });
        if (controller.signal.aborted) throw new DOMException('Demande interrompue.', 'AbortError');
        if (result.status === 'failed') throw new Error(result.error ?? 'La préparation du MP4 a échoué. Vous pouvez toujours récupérer l’original.');
        if (result.status === 'ready') {
          if (!result.ticket) throw new Error('Le studio n’a pas transmis le fichier MP4 préparé.');
          const ticket = safeSession(result.ticket, 'mp4-downloads');
          const headAbort = new AbortController();
          const headTimer = setTimeout(() => headAbort.abort(), 30_000);
          const cancelHead = () => headAbort.abort();
          controller.signal.addEventListener('abort', cancelHead, { once: true });
          try {
            if (controller.signal.aborted) throw new DOMException('Demande interrompue.', 'AbortError');
            const response = await fetch(ticket.url, { method: 'HEAD', signal: headAbort.signal, redirect: 'error' });
            if (!response.ok) throw new Error('Le fichier MP4 n’est plus disponible ou le lien a expiré. Réessayez depuis cette prise.');
            if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'video/mp4'
              || !/^attachment(?:\s*;|$)/i.test(response.headers.get('content-disposition') ?? '')) {
              throw new Error('Le studio n’a pas confirmé un fichier MP4 téléchargeable. Réessayez depuis cette prise.');
            }
          } finally { clearTimeout(headTimer); controller.signal.removeEventListener('abort', cancelHead); }
          if (controller.signal.aborted) throw new DOMException('Demande interrompue.', 'AbortError');
          const anchor = document.createElement('a');
          anchor.href = ticket.url; anchor.download = ''; anchor.rel = 'noreferrer';
          document.body.append(anchor); anchor.click(); anchor.remove();
          notify('Le téléchargement du MP4 a été lancé. Consultez les téléchargements de votre navigateur ; l’original est conservé.');
          return;
        }
        if (result.status !== 'preparing') throw new Error('Le studio a transmis un état de préparation MP4 invalide.');
        await new Promise<void>((resolve, reject) => {
          const finish = () => { controller.signal.removeEventListener('abort', cancelWait); resolve(); };
          const wait = setTimeout(finish, 1500);
          const cancelWait = () => { clearTimeout(wait); controller.signal.removeEventListener('abort', cancelWait); reject(new DOMException('Demande interrompue.', 'AbortError')); };
          controller.signal.addEventListener('abort', cancelWait, { once: true });
          if (controller.signal.aborted) cancelWait();
        });
      }
      throw new Error('La préparation du MP4 est trop longue. Vérifiez le PC puis réessayez.');
    } catch (failure) {
      if (!controller.signal.aborted || failure instanceof ApiFailure) throw failure;
      notify(Date.now() >= deadline
        ? 'La préparation du MP4 est trop longue. Vérifiez le PC puis réessayez.'
        : 'Attente du MP4 interrompue. Le PC peut continuer la préparation ; relancez le téléchargement quand vous le souhaitez.');
    } finally { clearTimeout(timer); mp4Preparations.delete(id); }
  });
}

async function mediaFileSession(id: string): Promise<FilePlaybackSession> {
  return safeSession(await api<FilePlaybackSession>(`/library/${encodeURIComponent(id)}/file-ticket`, { method: 'POST', body: '{}' }), 'library-files');
}

async function takePlaybackSession(id: string): Promise<TakePlaybackStatus> {
  const result = await api<TakePlaybackStatus>(`/takes/${encodeURIComponent(id)}/playback-session`, { method: 'POST', body: JSON.stringify({ mimeType: 'video/mp4' }) });
  if (result.session) safeSession(result.session, 'playback-files');
  return result;
}

async function exportProject(id: string): Promise<void> {
  await run(`export:${id}`, async () => {
    const ticket = safeSession(await api<DownloadTicket>(`/projects/${encodeURIComponent(id)}/export-ticket`, { method: 'POST', body: '{}' }), 'production-exports');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(ticket.url, { method: 'HEAD', signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Le dossier n’est plus disponible. Vérifiez les fichiers sur le PC puis réessayez.');
      }
    } finally { clearTimeout(timer); }
    const anchor = document.createElement('a');
    anchor.href = ticket.url;
    anchor.download = '';
    anchor.rel = 'noreferrer';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    notify('Le téléchargement du dossier complet a été lancé. Consultez les téléchargements de votre navigateur.');
  });
}

function cancelResolveExport(id: string): void { resolvePreparations.get(id)?.abort(); }

async function exportResolve(id: string): Promise<void> {
  await run(`resolve-export:${id}`, async () => {
    const controller = new AbortController();
    resolvePreparations.set(id, controller);
    const deadline = Date.now() + 30 * 60_000;
    const timer = setTimeout(() => controller.abort(), 30 * 60_000);
    try {
      while (Date.now() < deadline) {
        const result = await api<ResolveExportStatus>(`/projects/${encodeURIComponent(id)}/resolve-export-ticket`, { method: 'POST', body: '{}', signal: controller.signal });
        if (result.status === 'failed') throw new Error(result.error ?? 'La préparation DaVinci Resolve a échoué.');
        if (result.status === 'ready') {
          if (!result.ticket) throw new Error('Le studio n’a pas transmis le dossier préparé.');
          const ticket = safeSession(result.ticket, 'resolve-exports');
          const headAbort = new AbortController();
          const headTimer = setTimeout(() => headAbort.abort(), 30_000);
          const cancelHead = () => headAbort.abort();
          controller.signal.addEventListener('abort', cancelHead, { once: true });
          try {
            if (controller.signal.aborted) throw new DOMException('Demande interrompue.', 'AbortError');
            const response = await fetch(ticket.url, { method: 'HEAD', signal: headAbort.signal });
            if (!response.ok) throw new Error('Le dossier préparé n’est plus disponible. Réessayez depuis cette production.');
          } finally { clearTimeout(headTimer); controller.signal.removeEventListener('abort', cancelHead); }
          if (controller.signal.aborted) throw new DOMException('Demande interrompue.', 'AbortError');
          const anchor = document.createElement('a');
          anchor.href = ticket.url; anchor.download = ''; anchor.rel = 'noreferrer';
          document.body.append(anchor); anchor.click(); anchor.remove();
          notify('Le téléchargement pour DaVinci Resolve a été lancé. Décompressez le dossier puis importez une timeline .otio.');
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const finish = () => { controller.signal.removeEventListener('abort', cancelWait); resolve(); };
          const wait = setTimeout(finish, 1500);
          const cancelWait = () => { clearTimeout(wait); controller.signal.removeEventListener('abort', cancelWait); reject(new DOMException('Demande interrompue.', 'AbortError')); };
          controller.signal.addEventListener('abort', cancelWait, { once: true });
          if (controller.signal.aborted) cancelWait();
        });
      }
      throw new Error('La préparation est trop longue. Vérifiez le PC puis réessayez.');
    } catch (failure) {
      if (!controller.signal.aborted || failure instanceof ApiFailure) throw failure;
      notify(Date.now() >= deadline ? 'La préparation est trop longue. Vérifiez le PC puis réessayez.' : 'Attente interrompue. Vous pourrez récupérer le dossier en relançant sa préparation.');
    } finally { clearTimeout(timer); resolvePreparations.delete(id); }
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

async function imageThumbnail(path: string): Promise<string | null> {
  const response = await thumbnailResponse(path);
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

const takeThumbnail = (id: string) => imageThumbnail(`/takes/${encodeURIComponent(id)}/thumbnail`);
const mediaThumbnail = (id: string) => imageThumbnail(`/library/${encodeURIComponent(id)}/thumbnail`);

export function useStudio() {
  return {
    device, state, initialized, live, audioFrame, audioReceivedAt, error, notice, busy, canEdit, technician, guestInvitations,
    initialize, pair, forgetDevice, saveProject, preparation, control, connectObs, saveRoom, downloadTake, downloadTakeMp4, cancelTakeMp4Download, sceneThumbnail, takeThumbnail,
    suspendStudioConnection: () => { controllerEnabled = false; stopEvents(); },
    uploadMedia, updateMedia, saveProjectMedia, mediaFileSession, takePlaybackSession, exportProject, exportResolve, cancelResolveExport, mediaThumbnail,
    getDevices: () => run('devices', () => api<Device[]>('/devices')),
    createPairing: (role: Device['role'] = 'operator') => run('pairing', () => api<PairingCode>('/pairing', { method: 'POST', body: JSON.stringify({ role, kind: 'ipad' }) })),
    createStreamDeck: (name: string) => run('streamdeck', () => api<AuthResult>('/devices', { method: 'POST', body: JSON.stringify({ name, kind: 'streamdeck', role: 'operator' }) })),
    revokeDevice: (id: string) => run('revoke', async () => { await api<void>(`/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }); notify('Accès de l’appareil révoqué.'); return true; }),
    refresh: () => run('refresh', async () => { applyState(await api<StudioState>('/state')); }),
    previewSession: () => run('preview-session', () => api<PreviewSession>('/monitor/session', { method: 'POST', body: '{}' })),
    inviteGuest: (projectId: string, slot: 1 | 2, name: string) => run(`guest-invite:${slot}`, async () => {
      const invitation = await api<GuestInvitation>(`/projects/${encodeURIComponent(projectId)}/guests/invitations`, { method: 'POST', body: JSON.stringify({ slot, name }) });
      applyState(await api<StudioState>('/state'));
      guestInvitations.value = { ...guestInvitations.value, [projectId]: { ...guestInvitations.value[projectId], [slot]: invitation } };
      return invitation;
    }),
    guestBridgeSession: (projectId: string) => run('guest-bridge', () => api<GuestSession>(`/projects/${encodeURIComponent(projectId)}/guests/bridge-session`, { method: 'POST', body: '{}' })),
  };
}
