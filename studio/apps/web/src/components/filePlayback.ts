import type { FilePlaybackSession } from '@gabin/shared';

export function playbackUrl(session: FilePlaybackSession): string {
  const url = new URL(session.url, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.username || url.password) {
    throw new Error('L’adresse du fichier n’est pas valide. Demandez un nouvel accès.');
  }
  if (!Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) {
    throw new Error('L’accès au fichier a expiré. Demandez un nouvel accès.');
  }
  return url.href;
}

export function saveFile(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.referrerPolicy = 'no-referrer';
  document.body.append(link);
  link.click();
  link.remove();
}

export const failureText = (error: unknown, fallback = 'Le fichier ne peut pas être ouvert. Réessayez.') => error instanceof Error ? error.message : fallback;
