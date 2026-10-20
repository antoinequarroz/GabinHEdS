import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { buildGuestApp } from './guest-app.js';

const defaultDataDir = fileURLToPath(new URL('../../../.data', import.meta.url));
const port = Number(process.env.GABIN_PORT ?? process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GABIN_PORT doit être un port TCP valide.');
const shutdownToken = process.env.NINO_LOCAL_SHUTDOWN_TOKEN;
let shutdownTask: Promise<void> | undefined;
const app = await buildApp({ dataDir: path.resolve(process.env.GABIN_DATA_DIR ?? defaultDataDir), logger: true, companion: true,
  localLifecycle: shutdownToken ? { token: shutdownToken, onShutdown: () => shutdown().then(() => process.exit(0), () => process.exit(1)) } : undefined });
const guestApp = await buildGuestApp({ guests: app.guests, webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)), logger: true });
try {
  await guestApp.listen({ host: process.env.NINO_GUEST_HOST ?? '127.0.0.1', port: app.guests.port });
  await app.listen({ host: process.env.GABIN_HOST ?? '127.0.0.1', port });
} catch (error) { await guestApp.close(); await app.close(); throw error; }
function shutdown(): Promise<void> {
  return shutdownTask ??= guestApp.close().then(() => app.close());
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  void shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
});
