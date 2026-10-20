import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiFailure } from './validation.js';

export const LOCAL_SHUTDOWN_PATH = '/api/local-shutdown';
export interface LocalLifecycleOptions {
  /** Per-launch secret held by the native launcher, never a browser device token. */
  token: string;
  onShutdown: () => void | Promise<void>;
}

function nativeLoopback(request: FastifyRequest): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.raw.socket.remoteAddress || '')
    && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(request.headers.host || '')
    && request.headers.origin === undefined
    && !Object.keys(request.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-')
      || name === 'x-real-ip' || name === 'x-nino-client-ip');
}

export function registerLocalLifecycle(app: FastifyInstance, options: LocalLifecycleOptions,
  prepareShutdown: () => Promise<void>): void {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.token)) throw new Error('Le secret du lanceur local est invalide.');
  const expected = createHash('sha256').update(options.token).digest();
  app.post(LOCAL_SHUTDOWN_PATH, async (request, reply) => {
    if (!nativeLoopback(request)) throw new ApiFailure(403, 'L’arrêt doit être demandé par le lanceur sur ce PC.', 'LOCAL_ONLY');
    const authorization = request.headers.authorization || '';
    const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const actual = createHash('sha256').update(candidate).digest();
    if (!timingSafeEqual(expected, actual)) throw new ApiFailure(401, 'Le lanceur local n’est pas authentifié.', 'UNAUTHENTICATED');
    await prepareShutdown();
    // The caller must receive the acknowledgement before either listener closes.
    reply.raw.once('finish', () => {
      setImmediate(() => { void Promise.resolve().then(() => options.onShutdown()).catch(() => {
        app.log.error('L’arrêt local de Nino n’a pas pu être terminé.');
      }); });
    });
    return reply.code(202).send({ accepted: true, status: 'stopping' });
  });
}
