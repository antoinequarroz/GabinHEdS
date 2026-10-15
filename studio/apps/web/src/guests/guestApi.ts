import type { GuestSession } from '@gabin/shared';

export interface InvitationInfo { name: string; title: string; slot: 1 | 2; expiresAt: string; available: boolean; error?: string; }
export async function guestApi<T>(path: string, body: unknown): Promise<T> {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    const response = await fetch(`/api/guest/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: abort.signal });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error ?? 'Le studio n’a pas accepté la connexion.');
    return result;
  } catch (error) {
    if (error instanceof Error && error.name !== 'AbortError') throw error;
    throw new Error('Le studio ne répond pas. Vérifiez votre connexion puis réessayez.');
  } finally { clearTimeout(timer); }
}
export function validSession(session: GuestSession): GuestSession {
  const url = new URL(session.socketPath, location.origin);
  const local = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (!['ws:', 'wss:'].includes(url.protocol) || (url.protocol === 'ws:' && url.hostname !== location.hostname && !(local(url.hostname) && local(location.hostname))) || (location.protocol === 'https:' && url.protocol !== 'wss:' && !local(url.hostname)) || url.pathname !== '/api/guest/events' || url.search || url.hash || url.username || url.password) throw new Error('Le lien de connexion transmis par le studio est invalide.');
  return session;
}
export const bridgeSessionKey = 'nino.guest.bridge-session';
export function captureError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Autorisez la caméra et le micro dans votre navigateur, puis réessayez.';
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return 'Cette caméra ou ce micro est indisponible. Choisissez un autre appareil.';
    if (error.name === 'NotReadableError') return 'Cette caméra ou ce micro est déjà utilisé. Vérifiez les autres applications.';
  }
  return error instanceof Error ? error.message : 'La caméra et le micro n’ont pas pu être ouverts.';
}
