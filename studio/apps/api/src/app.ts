import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { WebSocket } from 'ws';
import type { Device, DeviceRole, ProjectInput, StudioState, Take } from '@gabin/shared';
import { RealObsGateway, type ObsGateway } from './obs.js';
import { RealMediaGateway, validHlsResource, type MediaGateway } from './media.js';
import { hashSecret, Store } from './store.js';
import { Studio } from './studio.js';
import { TakeThumbnails } from './thumbnails.js';
import { libraryFile, registerLibraryRoutes } from './library.js';
import { registerProductionFileRoutes } from './production-files.js';
import { ApiFailure, choice, controlInput, object, projectInput, roomInput, string } from './validation.js';

declare module 'fastify' { interface FastifyRequest { device?: Device } }
export interface AppOptions { dataDir: string; obs?: ObsGateway; media?: MediaGateway; webDir?: string; logger?: boolean }
const roles: DeviceRole[] = ['viewer', 'operator', 'technician'];
const kinds = ['pc', 'ipad', 'streamdeck'] as const;
const loopbackPeer = (ip: string | undefined): boolean => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

function websocketSources(request: FastifyRequest): string {
  const host = request.headers.host;
  if (!host || !/^(?:\[[0-9A-Fa-f:.]+\]|[a-zA-Z0-9.-]+)(?::\d{1,5})?$/.test(host)) return '';
  try {
    // Safari needs explicit WebSocket schemes. Keep the external Host/port for
    // HTTPS proxies, without permitting arbitrary connection destinations.
    return `${new URL(`ws://${host}`).origin} ${new URL(`wss://${host}`).origin}`;
  } catch { return ''; }
}

function sameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // Native controllers authenticate with bearer tokens.
  try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && url.host.toLowerCase() === request.headers.host?.toLowerCase(); }
  catch { return false; }
}
function requireRole(request: FastifyRequest, minimum: DeviceRole): Device {
  const device = request.device;
  if (!device) throw new ApiFailure(401, 'Appareil non connecté.', 'UNAUTHENTICATED');
  if (roles.indexOf(device.role) < roles.indexOf(minimum)) throw new ApiFailure(403, 'Cet appareil ne possède pas les droits nécessaires.', 'FORBIDDEN');
  return device;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ? { redact: ['req.headers.authorization', 'req.body.obsPassword', 'req.body.liveDestination.key', 'req.body.token', 'req.url'] } : false,
    trustProxy: false, bodyLimit: 64 * 1024, requestTimeout: 30 * 60_000, connectionTimeout: 60_000 });
  app.server.headersTimeout = 30_000;
  const store = new Store(options.dataDir);
  const media = options.media ?? new RealMediaGateway();
  const studio = new Studio(store, options.obs ?? new RealObsGateway(), media);
  const takeThumbnails = new TakeThumbnails();
  void media.refresh().catch(() => undefined);
  const clients = new Map<WebSocket, Device>();
  const downloadTickets = new Map<string, { takeId: string; deviceId: string; expiresAt: number }>();
  const monitorTickets = new Map<string, { deviceId: string; createdAt: number; lastUsedAt: number }>();
  const monitorTicketValid = (ticket: { createdAt: number; lastUsedAt: number }): boolean => Date.now() - ticket.createdAt < 12 * 3600_000 && Date.now() - ticket.lastUsedAt < 15 * 60_000;
  const accessUrls = (): string[] => {
    const address = app.server.address();
    if (!address || typeof address === 'string' || loopbackPeer(address.address)) return [];
    if (address.address === '0.0.0.0' || address.address === '::') {
      return Object.values(os.networkInterfaces()).flat().filter((entry) => entry && !entry.internal && entry.family === 'IPv4'
        // Link-local and VPN benchmarking interfaces are not usable LAN links
        // for the tablet. Prefer the actual address of the room's network.
        && !entry.address.startsWith('169.254.') && !/^198\.(?:18|19)\./.test(entry.address))
        .map((entry) => `http://${entry!.address}:${address.port}`);
    }
    return [`http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`];
  };
  const state = (): StudioState => ({ ...studio.state(), accessUrls: accessUrls() });
  const sendState = (socket: WebSocket): void => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'state', state: state() }));
  };
  const unsubscribe = studio.subscribe(() => {
    for (const [socket, device] of clients) {
      if (!store.device(device.id)) { socket.close(4001, 'Accès révoqué ou expiré'); clients.delete(socket); }
      else sendState(socket);
    }
  });
  let lastAudioSentAt = 0;
  const unsubscribeAudio = studio.subscribeAudio((frame) => {
    const now = Date.now();
    if (now - lastAudioSentAt < 100) return;
    lastAudioSentAt = now;
    const payload = JSON.stringify({ type: 'audio', frame });
    for (const [socket, device] of clients) {
      if (!store.device(device.id)) { socket.close(4001, 'Accès révoqué ou expiré'); clients.delete(socket); }
      // Drop ephemeral frames for slow receivers rather than buffering meters.
      else if (socket.readyState === 1 && socket.bufferedAmount < 64 * 1024) socket.send(payload);
    }
  });
  const expiryTimer = setInterval(() => {
    for (const [hash, ticket] of downloadTickets) if (ticket.expiresAt <= Date.now()) downloadTickets.delete(hash);
    for (const [hash, ticket] of monitorTickets) if (!monitorTicketValid(ticket)) monitorTickets.delete(hash);
    for (const [socket, device] of clients) {
      if (!store.device(device.id)) socket.close(4001, 'Accès révoqué ou expiré');
      else if (socket.readyState === 1) socket.ping();
    }
  }, 30_000);
  expiryTimer.unref();

  await app.register(rateLimit, { global: false, keyGenerator: (request) => request.raw.socket.remoteAddress ?? 'unknown' });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'same-origin').header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      .header('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${websocketSources(request)}; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!sameOrigin(request)) throw new ApiFailure(403, 'Origine de la requête non autorisée.', 'ORIGIN_REJECTED');
    const route = request.url.split('?')[0];
    if (['/api/auth/local', '/api/auth/pair', '/api/events'].includes(route) || /^\/api\/downloads\/[a-zA-Z0-9_-]{43}$/.test(route)
      || /^\/api\/(?:library-files|playback-files|production-exports|resolve-exports)\/[a-zA-Z0-9_-]{43}$/.test(route)
      || /^\/api\/monitor\/[a-zA-Z0-9_-]{43}\/[a-zA-Z0-9_.-]+$/.test(route)) return;
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length > 512) throw new ApiFailure(401, 'Connectez cet appareil à la salle.', 'UNAUTHENTICATED');
    const device = store.deviceForToken(authorization.slice(7));
    if (!device) throw new ApiFailure(401, 'Accès révoqué ou expiré. Reconnectez cet appareil.', 'UNAUTHENTICATED');
    request.device = device;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiFailure) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    const candidate = error as { statusCode?: unknown };
    const statusCode = typeof candidate?.statusCode === 'number' && candidate.statusCode >= 400 && candidate.statusCode < 500 ? candidate.statusCode : 500;
    app.log.error({ err: error }, 'API request failed');
    return reply.code(statusCode).send({ error: statusCode === 429 ? 'Trop de tentatives. Patientez avant de réessayer.' : statusCode === 413 ? 'Le fichier dépasse la taille maximale autorisée (1 Go).' : statusCode === 400 ? 'Requête invalide.' : 'Impossible de terminer cette opération. Vérifiez OBS et les journaux du serveur.', code: statusCode === 429 ? 'RATE_LIMITED' : 'REQUEST_FAILED' });
  });

  app.post('/api/auth/local', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (request) => {
    let hostname: string;
    try { hostname = new URL(`http://${request.headers.host}`).hostname; } catch { hostname = ''; }
    if (!loopbackPeer(request.raw.socket.remoteAddress) || !['localhost', '127.0.0.1', '[::1]'].includes(hostname)
      || request.headers.forwarded || request.headers['x-forwarded-for'] || request.headers['x-forwarded-host']) {
      throw new ApiFailure(403, 'L’accès technicien initial doit être créé sur le PC de la salle, via localhost.', 'LOCAL_ONLY');
    }
    const body = request.body === undefined ? {} : object(request.body);
    return store.createDevice(body.name === undefined ? 'PC de la salle' : string(body.name, 'appareil', 100), 'pc', 'technician');
  });
  app.post('/api/auth/pair', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const body = object(request.body);
    const result = store.usePairing(string(body.code, 'code', 6), string(body.name, 'appareil', 100), choice(body.kind, kinds, 'type d’appareil'));
    if (!result) throw new ApiFailure(401, 'Code invalide, déjà utilisé ou expiré.', 'PAIRING_REJECTED');
    return result;
  });
  app.get('/api/auth/me', async (request) => request.device!);
  app.post('/api/pairing', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    requireRole(request, 'technician');
    const body = object(request.body);
    return store.createPairing(choice(body.role, roles, 'rôle'), choice(body.kind, kinds, 'type d’appareil'));
  });
  app.get('/api/devices', async (request) => { requireRole(request, 'technician'); return store.devices(); });
  app.post('/api/devices', async (request) => {
    requireRole(request, 'technician');
    const body = object(request.body);
    const kind = choice(body.kind, ['streamdeck'] as const, 'type d’appareil');
    const role = choice(body.role, ['operator', 'viewer'] as const, 'rôle');
    return store.createDevice(string(body.name, 'appareil', 100), kind, role, true);
  });
  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (request, reply) => {
    requireRole(request, 'technician');
    if (!store.revoke(request.params.id)) throw new ApiFailure(404, 'Appareil introuvable.', 'NOT_FOUND');
    studio.revokeAutoDevice(request.params.id);
    for (const [socket, device] of clients) if (device.id === request.params.id) socket.close(4001, 'Accès révoqué');
    return reply.code(204).send();
  });
  app.get('/api/state', async () => state());
  app.get<{ Querystring: { name?: string } }>('/api/obs/scenes/thumbnail', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (request) => {
    const sceneName = string(request.query.name, 'scène', 200);
    const current = studio.obs.getState();
    if (!current.scenes.includes(sceneName)) throw new ApiFailure(404, 'Cette scène n’est pas disponible dans OBS.', 'SCENE_NOT_FOUND');
    const result = await studio.obs.sceneThumbnail(sceneName);
    if (!store.device(request.device!.id)) throw new ApiFailure(401, 'L’accès de cet appareil a été révoqué.', 'UNAUTHENTICATED');
    return result;
  });
  app.get('/api/projects', async () => store.projects());
  app.post('/api/projects', async (request, reply) => {
    requireRole(request, 'operator');
    const input = projectInput(request.body) as ProjectInput;
    const result = await studio.serial(() => studio.createProject(input));
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (request) => {
    requireRole(request, 'operator');
    const input = projectInput(request.body, true);
    const body = object(request.body);
    const status = body.status === undefined ? undefined : string(body.status, 'état', 30);
    return studio.serial(() => studio.updateProject(request.params.id, input, status));
  });
  app.get<{ Params: { projectId: string } }>('/api/preparation/:projectId', async (request) => studio.serial(() => studio.preparation(request.params.projectId)));
  app.get('/api/room', async () => store.publicRoom());
  app.patch('/api/room', async (request) => {
    requireRole(request, 'technician');
    const input = roomInput(request.body);
    return studio.serial(() => { studio.updateRoom(input); return store.publicRoom(); });
  });
  app.post('/api/obs/connect', async (request) => {
    requireRole(request, 'technician');
    await studio.serial(() => studio.connect());
    return state();
  });
  app.post('/api/obs/disconnect', async (request) => {
    requireRole(request, 'technician');
    await studio.serial(() => studio.disconnect());
    return state();
  });
  app.post('/api/control', async (request) => {
    const device = requireRole(request, 'operator');
    const command = controlInput(request.body);
    const requestId = command.requestId ?? randomUUID();
    const { requestId: _requestId, ...payload } = command;
    const fingerprint = JSON.stringify(payload);
    await studio.serial(async () => {
      // Check revocation again after waiting behind another controller’s command.
      if (!store.device(device.id)) throw new ApiFailure(401, 'L’accès de cet appareil a été révoqué.', 'UNAUTHENTICATED');
      const previous = store.command(device.id, requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ApiFailure(409, 'Cet identifiant de commande a déjà servi pour une autre action.', 'IDEMPOTENCY_CONFLICT');
        return;
      }
      await studio.control(command, { deviceId: device.id });
      store.rememberCommand(device.id, requestId, fingerprint, { ok: true });
    });
    return state();
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/takes', async (request) => {
    studio.project(request.params.id);
    return store.takes().filter((take) => take.projectId === request.params.id);
  });
  const resolveTakeFile = async (takeId: string) => {
    const take = store.get<Take>('take', takeId);
    if (!take || take.status !== 'completed' || !take.outputPath) throw new ApiFailure(404, 'Aucun fichier terminé disponible pour cette prise.', 'FILE_NOT_FOUND');
    let file: string, directory: string;
    try { [file, directory] = await Promise.all([realpath(take.outputPath), realpath(take.recordingDirectory)]); }
    catch { throw new ApiFailure(404, 'Le fichier a été déplacé ou supprimé sur le PC.', 'FILE_NOT_FOUND'); }
    const relative = path.relative(directory, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new ApiFailure(403, 'Le fichier est hors du dossier de cette prise.', 'FILE_OUTSIDE_TAKE');
    const fileStat = await stat(file);
    if (!fileStat.isFile()) throw new ApiFailure(404, 'Fichier vidéo introuvable.', 'FILE_NOT_FOUND');
    return { take, file, fileStat };
  };
  await registerLibraryRoutes(app, { store, studio, requireRole, state });
  await registerProductionFileRoutes(app, { store, studio, requireRole, resolveTakeFile });
  app.get<{ Params: { id: string } }>('/api/library/:id/thumbnail', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { asset, file, fileStat } = await libraryFile(store, request.params.id);
    if (asset.kind !== 'video') throw new ApiFailure(404, 'Ce média ne possède pas d’affiche vidéo.', 'THUMBNAIL_UNAVAILABLE');
    const image = await takeThumbnails.image(file, fileStat.mtimeMs, fileStat.size);
    if (!store.device(request.device!.id)) throw new ApiFailure(401, 'L’accès de cet appareil a été révoqué.', 'UNAUTHENTICATED');
    return reply.type('image/jpeg').header('Content-Length', image.length).send(image);
  });
  const sendTakeFile = async (takeId: string, request: FastifyRequest, reply: FastifyReply) => {
    const { take, file, fileStat } = await resolveTakeFile(takeId);
    const filename = `${take.title.replace(/[^a-zA-Z0-9 -]/g, '').slice(0, 100) || 'prise'}${path.extname(file).slice(0, 10)}`;
    reply.header('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(take.title + path.extname(file))}`)
      .header('Accept-Ranges', 'bytes').type('application/octet-stream');
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      const start = match?.[1] ? +match[1] : Math.max(0, fileStat.size - +(match?.[2] ?? '0'));
      const end = match?.[1] && match[2] ? Math.min(+match[2], fileStat.size - 1) : fileStat.size - 1;
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= fileStat.size) {
        return reply.code(416).header('Content-Range', `bytes */${fileStat.size}`).send();
      }
      return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${fileStat.size}`).header('Content-Length', end - start + 1).send(createReadStream(file, { start, end }));
    }
    return reply.header('Content-Length', fileStat.size).send(createReadStream(file));
  };
  app.get<{ Params: { id: string } }>('/api/takes/:id/file', async (request, reply) => sendTakeFile(request.params.id, request, reply));
  app.get<{ Params: { id: string } }>('/api/takes/:id/thumbnail', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { file, fileStat } = await resolveTakeFile(request.params.id);
    const data = await takeThumbnails.image(file, fileStat.mtimeMs, fileStat.size);
    if (!store.device(request.device!.id)) throw new ApiFailure(401, 'L’accès de cet appareil a été révoqué.', 'UNAUTHENTICATED');
    return reply.type('image/jpeg').header('Content-Length', data.length).send(data);
  });
  app.post<{ Params: { id: string } }>('/api/takes/:id/download-ticket', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    const take = store.takes().find((item) => item.id === request.params.id);
    if (!take || take.status !== 'completed' || !take.outputPath) throw new ApiFailure(404, 'Aucun fichier terminé disponible pour cette prise.', 'FILE_NOT_FOUND');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 5 * 60_000;
    if (downloadTickets.size >= 1000) downloadTickets.delete(downloadTickets.keys().next().value!);
    downloadTickets.set(hashSecret(token), { takeId: take.id, deviceId: request.device!.id, expiresAt });
    return { url: `/api/downloads/${token}`, expiresAt: new Date(expiresAt).toISOString() };
  });
  app.get<{ Params: { token: string } }>('/api/downloads/:token', async (request, reply) => {
    const ticket = downloadTickets.get(hashSecret(request.params.token));
    if (!ticket || ticket.expiresAt <= Date.now() || !store.device(ticket.deviceId)) throw new ApiFailure(401, 'Ce lien a expiré ou l’accès de cet appareil a été révoqué.', 'DOWNLOAD_EXPIRED');
    return sendTakeFile(ticket.takeId, request, reply);
  });
  app.post('/api/monitor/session', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    await media.refresh();
    if (!media.getState().previewReady) throw new ApiFailure(409, media.getState().previewError || 'Activez le retour programme et attendez qu’il soit disponible.', 'PREVIEW_NOT_READY');
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    if (monitorTickets.size >= 1000) monitorTickets.delete(monitorTickets.keys().next().value!);
    monitorTickets.set(hashSecret(token), { deviceId: request.device!.id, createdAt: now, lastUsedAt: now });
    return { url: `/api/monitor/${token}/index.m3u8`, expiresAt: new Date(now + 15 * 60_000).toISOString() };
  });
  app.get<{ Params: { token: string; resource: string } }>('/api/monitor/:token/:resource', async (request, reply) => {
    const ticket = monitorTickets.get(hashSecret(request.params.token));
    if (!ticket || !monitorTicketValid(ticket) || !store.device(ticket.deviceId)) throw new ApiFailure(401, 'Session de retour vidéo expirée ou accès révoqué.', 'MONITOR_EXPIRED');
    const queryIndex = request.url.indexOf('?');
    const resource = request.params.resource + (queryIndex < 0 ? '' : request.url.slice(queryIndex));
    if (!validHlsResource(resource)) throw new ApiFailure(400, 'Ressource vidéo non autorisée.', 'INVALID_MEDIA_RESOURCE');
    ticket.lastUsedAt = Date.now();
    let upstream: Response;
    try { upstream = await media.hlsResource(resource); }
    catch { throw new ApiFailure(503, 'Le retour programme ne répond pas. Réessayez dans quelques secondes.', 'PREVIEW_NOT_READY'); }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new ApiFailure(upstream.status === 404 ? 404 : 503, 'Le retour programme n’est pas encore disponible. Réessayez dans quelques secondes.', 'PREVIEW_NOT_READY');
    }
    reply.header('Cache-Control', 'no-store');
    if (request.params.resource.endsWith('.m3u8')) {
      const playlist = await upstream.text();
      // MediaMTX emits relative URIs. Preserve the authenticated ticket prefix;
      // reject any absolute/external URI rather than leaking a local media path.
      const checked = playlist.split(/\r?\n/).map((line) => {
        if (line && !line.startsWith('#') && !validHlsResource(line)) throw new ApiFailure(502, 'Format du retour vidéo non reconnu.', 'INVALID_MEDIA_PLAYLIST');
        for (const match of line.matchAll(/URI="([^"]+)"/g)) if (!validHlsResource(match[1])) throw new ApiFailure(502, 'Format du retour vidéo non reconnu.', 'INVALID_MEDIA_PLAYLIST');
        return line;
      }).join('\n');
      return reply.type('application/vnd.apple.mpegurl').send(checked);
    }
    if (!upstream.body) throw new ApiFailure(503, 'Le segment vidéo est vide.', 'PREVIEW_NOT_READY');
    reply.type(request.params.resource.endsWith('.ts') ? 'video/mp2t' : 'video/mp4');
    const length = upstream.headers.get('content-length');
    if (length && /^\d+$/.test(length)) reply.header('Content-Length', length);
    return reply.send(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]));
  });
  app.get('/api/events', { websocket: true }, (socket, request) => {
    if (!sameOrigin(request)) { socket.close(4003, 'Origine refusée'); return; }
    const authTimer = setTimeout(() => socket.close(4001, 'Authentification requise'), 5000);
    authTimer.unref();
    socket.on('message', (raw) => {
      if (clients.has(socket)) {
        if (!store.device(clients.get(socket)!.id)) socket.close(4001, 'Accès révoqué');
        return;
      }
      try {
        const message = object(JSON.parse(raw.toString()));
        const device = message.type === 'auth' && typeof message.token === 'string' && message.token.length <= 512 ? store.deviceForToken(message.token) : null;
        if (!device) { socket.close(4001, 'Accès invalide'); return; }
        clearTimeout(authTimer);
        clients.set(socket, device);
        sendState(socket);
      } catch { socket.close(4001, 'Message invalide'); }
    });
    socket.on('close', () => { clearTimeout(authTimer); clients.delete(socket); });
    socket.on('error', () => { clearTimeout(authTimer); clients.delete(socket); });
  });

  const webDir = options.webDir ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', cacheControl: true, maxAge: 0 });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.method !== 'GET' || path.extname(request.url.split('?')[0])) return reply.code(404).send({ error: 'Page introuvable.' });
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Ressource introuvable. Construisez l’interface pour la servir depuis ce serveur.' }));
  }
  app.addHook('onClose', async () => {
    takeThumbnails.close();
    clearInterval(expiryTimer);
    unsubscribe();
    unsubscribeAudio();
    for (const socket of clients.keys()) socket.close(1001, 'Serveur arrêté');
    await studio.close();
  });
  return app;
}
