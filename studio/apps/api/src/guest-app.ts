import Fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import type { WebSocket } from 'ws';
import { GuestService } from './guests.js';
import { ApiFailure, object } from './validation.js';

const localPeer = (ip: string | undefined): boolean => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip || '');
const localHost = (value: string | undefined): boolean => {
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${value}`).hostname); } catch { return false; }
};
function localRequest(request: FastifyRequest): boolean {
  return localPeer(request.raw.socket.remoteAddress) && localHost(request.headers.host)
    && !request.headers.forwarded && !request.headers['x-forwarded-for'] && !request.headers['x-forwarded-host'];
}
function allowedOrigin(request: FastifyRequest, guests: GuestService): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // OBS/native clients still need the scoped random token.
  try {
    const url = new URL(origin);
    if (url.origin === guests.publicUrl) return true;
    // The private controller sends its bridge token to this separate public gateway.
    // Only local PC origins are allowed; the bridge itself validates a PC operator grant.
    return localRequest(request) && ['http:', 'https:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
}
function clientKey(request: FastifyRequest, guests: GuestService): string {
  const ip = request.raw.socket.remoteAddress || 'unknown';
  const forwarded = request.headers['x-nino-client-ip'];
  // The dedicated edge overwrites this header. Its identity is useful only
  // for quotas, never for operator bootstrap or local source authorization.
  if (guests.config.trustLocalProxy && localPeer(ip) && guests.publicUrl.startsWith('https:') && !localRequest(request)) {
    let publicHost = false;
    try {
      const host = new URL(`https://${request.headers.host}`);
      publicHost = host.origin === guests.publicUrl && !host.username && !host.password && host.pathname === '/' && !host.search && !host.hash;
    } catch { /* malformed proxy host uses its own quota group */ }
    if (publicHost && typeof forwarded === 'string' && isIP(forwarded)) return `proxy:${forwarded}`;
    // Misconfigured or malformed forwarded traffic must not consume the
    // loopback group used by the room bridge and OBS browser sources.
    return `proxy-untrusted:${ip}`;
  }
  return `peer:${ip}`;
}

/** Separate guest-only listener. It must never register the private studio app or its API routes. */
export async function buildGuestApp(options: { guests: GuestService; webDir?: string; logger?: boolean }) {
  const { guests } = options;
  const app = Fastify({ logger: options.logger ? { redact: ['req.body.token', 'req.headers.authorization', 'req.url'] } : false,
    trustProxy: false, bodyLimit: 8 * 1024, requestTimeout: 15_000, connectionTimeout: 15_000 });
  app.server.headersTimeout = 15_000;
  await app.register(rateLimit, { global: true, max: 240, timeWindow: '1 minute', keyGenerator: request => clientKey(request, guests) });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  const sockets = new Set<WebSocket>();
  const byIp = new Map<string, number>();
  app.addHook('onRequest', async (request, reply) => {
    const publicSocket = guests.publicUrl.replace(/^http/, 'ws');
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer').header('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()')
      .header('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${publicSocket} ws://127.0.0.1:${guests.port} ws://localhost:${guests.port}; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!request.url.startsWith('/api/guest/')) throw new ApiFailure(404, 'Route introuvable.', 'NOT_FOUND');
    if (request.url.includes('?')) throw new ApiFailure(400, 'Les identifiants ne doivent pas être transmis dans l’URL.');
    if (!allowedOrigin(request, guests)) throw new ApiFailure(403, 'Origine invitée non autorisée.', 'ORIGIN_REJECTED');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiFailure) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    const status = (error as { statusCode?: number }).statusCode;
    const code = typeof status === 'number' && status >= 400 && status < 500 ? status : 500;
    if (code === 500) app.log.error({ err: error }, 'Guest gateway failed');
    return reply.code(code).send({ error: code === 429 ? 'Trop de tentatives. Patientez avant de réessayer.' : code === 413 ? 'Requête trop volumineuse.' : code === 400 ? 'Requête invitée invalide.' : 'La connexion invitée ne peut pas être terminée.', code: code === 429 ? 'RATE_LIMITED' : 'GUEST_REQUEST_FAILED' });
  });
  const body = (request: FastifyRequest, keys: string[]): Record<string, unknown> => {
    const data = object(request.body);
    if (Object.keys(data).some(key => !keys.includes(key))) throw new ApiFailure(400, 'Champ invité non reconnu.');
    return data;
  };
  app.get('/api/guest/config', async () => ({ mode: 'guest', configured: guests.publicUrl.startsWith('https:') }));
  app.post('/api/guest/invitation', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => guests.inspectInvitation(body(request, ['token']).token));
  app.post('/api/guest/join', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async request => {
    const data = body(request, ['token', 'name']);
    return guests.join(data.token, data.name);
  });
  app.post('/api/guest/resume', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => {
    const result = guests.resume(body(request, ['token']).token);
    if (result.role !== 'guest' && !localRequest(request)) throw new ApiFailure(403, 'Le retour et les sources OBS sont réservés au PC de la salle.', 'LOCAL_SOURCE_ONLY');
    return result;
  });
  app.post('/api/guest/source', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => {
    if (!localRequest(request)) throw new ApiFailure(403, 'La source OBS est réservée au PC de la salle.', 'LOCAL_SOURCE_ONLY');
    return guests.claimSource(body(request, ['token']).token);
  });
  app.get('/api/guest/events', { websocket: true }, (socket, request) => {
    const ip = clientKey(request, guests);
    const count = byIp.get(ip) || 0;
    if (count >= 16 || sockets.size >= 128) { socket.close(4008, 'Trop de connexions'); return; }
    sockets.add(socket); byIp.set(ip, count + 1);
    socket.on('close', () => { sockets.delete(socket); const remaining = (byIp.get(ip) || 1) - 1; if (remaining) byIp.set(ip, remaining); else byIp.delete(ip); });
    guests.attachSocket(socket, { allowSource: localRequest(request), allowBridge: localRequest(request) });
  });
  if (options.webDir && existsSync(options.webDir)) {
    await app.register(fastifyStatic, { root: options.webDir, index: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.method !== 'GET') return reply.code(404).send({ error: 'Route introuvable.', code: 'NOT_FOUND' });
      return reply.header('Cache-Control', 'no-store').sendFile('index.html');
    });
    app.get('/', (_request, reply) => reply.header('Cache-Control', 'no-store').sendFile('index.html'));
  }
  app.addHook('onClose', async () => { for (const socket of sockets) socket.close(1001, 'Passerelle arrêtée'); });
  return app;
}
