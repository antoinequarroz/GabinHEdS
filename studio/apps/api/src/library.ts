import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Device, DeviceRole, FilePlaybackSession, MediaAsset, MediaKind, StudioState } from '@gabin/shared';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileTypeFromFile } from 'file-type';
import { hashSecret, type Store } from './store.js';
import type { Studio } from './studio.js';
import { ApiFailure, object, projectMediaInput, string } from './validation.js';

export const maximumLibraryBytes = 1024 ** 3;
interface PrivateAsset { id: string; asset: MediaAsset; fileName: string; sha256: string }
const formats: Record<string, { kind: MediaKind; extension: string; demuxer?: string }> = {
  'image/png': { kind: 'image', extension: 'png', demuxer: 'png_pipe' },
  'image/jpeg': { kind: 'image', extension: 'jpg', demuxer: 'jpeg_pipe' },
  'image/gif': { kind: 'image', extension: 'gif', demuxer: 'gif' },
  'image/webp': { kind: 'image', extension: 'webp', demuxer: 'webp_pipe' },
  'video/mp4': { kind: 'video', extension: 'mp4', demuxer: 'mov' },
  'video/quicktime': { kind: 'video', extension: 'mov', demuxer: 'mov' },
  'video/x-matroska': { kind: 'video', extension: 'mkv', demuxer: 'matroska' },
  'video/webm': { kind: 'video', extension: 'webm', demuxer: 'matroska' },
  'audio/mpeg': { kind: 'audio', extension: 'mp3', demuxer: 'mp3' },
  'audio/wav': { kind: 'audio', extension: 'wav', demuxer: 'wav' },
  'audio/x-wav': { kind: 'audio', extension: 'wav', demuxer: 'wav' },
  'audio/flac': { kind: 'audio', extension: 'flac', demuxer: 'flac' },
  'audio/ogg': { kind: 'audio', extension: 'ogg', demuxer: 'ogg' },
  'audio/opus': { kind: 'audio', extension: 'opus', demuxer: 'ogg' },
  'audio/aac': { kind: 'audio', extension: 'aac', demuxer: 'aac' },
  'audio/mp4': { kind: 'audio', extension: 'm4a', demuxer: 'mov' },
  'audio/x-m4a': { kind: 'audio', extension: 'm4a', demuxer: 'mov' },
  'application/pdf': { kind: 'document', extension: 'pdf' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'document', extension: 'pptx' },
};
const mediaMissing = () => new ApiFailure(404, 'Ce fichier média n’est plus disponible dans la bibliothèque.', 'MEDIA_FILE_NOT_FOUND');

/** Resolve only immutable UUID names in the private library, never a caller's path. */
export async function libraryFile(store: Store, id: string): Promise<{ asset: MediaAsset; file: string; fileStat: Stats }> {
  const record = store.get<PrivateAsset>('mediaAsset', id);
  if (!record || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/.test(record.fileName) || record.id !== record.asset.id) throw mediaMissing();
  const expected = path.join(store.dataDir, 'library', record.fileName);
  let root: string, file: string, fileStat: Stats;
  try {
    const [data, library, candidate] = await Promise.all([realpath(store.dataDir), realpath(path.join(store.dataDir, 'library')), lstat(expected)]);
    if (path.relative(data, library) !== 'library' || candidate.isSymbolicLink() || !candidate.isFile()) throw mediaMissing();
    root = library;
    file = await realpath(expected);
    if (path.dirname(file) !== root || path.basename(file) !== record.fileName) throw mediaMissing();
    fileStat = await stat(file);
    if (!fileStat.isFile() || fileStat.size !== record.asset.sizeBytes) throw mediaMissing();
    const detected = await fileTypeFromFile(file);
    if (!detected || !formats[detected.mime] || detected.mime !== record.asset.mimeType) throw mediaMissing();
  } catch { throw mediaMissing(); }
  return { asset: structuredClone(record.asset), file, fileStat };
}

function probe(file: string, demuxer: string, children: Set<ChildProcess>): Promise<{ durationMs: number | null; width: number | null; height: number | null; hasVideo: boolean; hasAudio: boolean }> {
  const configured = process.env.GABIN_FFPROBE_PATH;
  const ffmpeg = process.env.GABIN_FFMPEG_PATH;
  const executable = configured ?? (ffmpeg ? path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', demuxer, '-i', file,
      '-show_entries', 'stream=codec_type,width,height,duration:format=duration', '-of', 'json'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    children.add(child);
    const chunks: Buffer[] = []; let bytes = 0; let failed = false;
    const fail = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(fail, 10_000); timer.unref();
    child.stdout!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) fail(); else chunks.push(chunk); });
    child.once('error', fail);
    child.once('close', code => {
      clearTimeout(timer);
      children.delete(child);
      if (failed || code !== 0) { reject(new ApiFailure(422, 'Ce média ne peut pas être lu. Vérifiez son format et la présence de FFmpeg/FFprobe sur le PC.', 'MEDIA_PROBE_FAILED')); return; }
      try {
        const metadata = JSON.parse(Buffer.concat(chunks).toString()) as { streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[]; format?: { duration?: string } };
        const video = metadata.streams?.find(stream => stream.codec_type === 'video');
        const seconds = Number(metadata.format?.duration ?? video?.duration);
        resolve({ durationMs: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null,
          width: Number.isInteger(video?.width) && video!.width! > 0 ? video!.width! : null,
          height: Number.isInteger(video?.height) && video!.height! > 0 ? video!.height! : null,
          hasVideo: !!video, hasAudio: !!metadata.streams?.some(stream => stream.codec_type === 'audio') });
      } catch { reject(new ApiFailure(422, 'Les informations de ce média ne sont pas lisibles.', 'MEDIA_PROBE_FAILED')); }
    });
  });
}

function stillAuthorized(store: Store, device: Device): void {
  if (!store.device(device.id)) throw new ApiFailure(401, 'L’accès de cet appareil a été révoqué pendant l’opération.', 'UNAUTHENTICATED');
}

export async function registerLibraryRoutes(app: FastifyInstance, options: {
  store: Store; studio: Studio; requireRole: (request: FastifyRequest, minimum: DeviceRole) => Device; state: () => StudioState;
}): Promise<void> {
  const { store, studio, requireRole } = options;
  await app.register(multipart, { limits: { fileSize: maximumLibraryBytes, files: 1, fields: 2, parts: 3, fieldSize: 1024 } });
  let uploads = 0;
  let closing = false;
  const uploadJobs = new Map<FastifyRequest['raw'], { streams: Set<Readable>; done: Promise<void>; finish: () => void }>();
  const transfers = new Set<Readable>();
  const probes = new Set<ChildProcess>();
  const assertOpen = () => { if (closing) throw new ApiFailure(503, 'Le studio est en cours d’arrêt. Réessayez après son redémarrage.', 'LIBRARY_CLOSING'); };
  const assertDevice = (device: Device) => { assertOpen(); stillAuthorized(store, device); };
  const monitor = (stream: Readable, deviceId: string) => {
    try { assertOpen(); if (!store.device(deviceId)) throw new ApiFailure(401, 'L’accès de cet appareil a été révoqué.', 'UNAUTHENTICATED'); }
    catch (error) { stream.destroy(); throw error; }
    transfers.add(stream);
    const guard = setInterval(() => {
      if (closing || !store.device(deviceId)) stream.destroy(new Error('Library transfer no longer authorized'));
    }, 1000);
    guard.unref();
    const complete = () => { clearInterval(guard); transfers.delete(stream); };
    stream.once('end', complete); stream.once('close', complete);
  };
  const tickets = new Map<string, { assetId: string; deviceId: string; expiresAt: number }>();
  const expiry = setInterval(() => { for (const [key, ticket] of tickets) if (ticket.expiresAt <= Date.now()) tickets.delete(key); }, 30_000);
  expiry.unref();
  app.addHook('preClose', async () => {
    closing = true;
    const jobs = [...uploadJobs];
    for (const [request, job] of jobs) {
      for (const stream of job.streams) stream.destroy(new Error('Library upload cancelled during shutdown'));
      request.destroy();
    }
    for (const stream of transfers) stream.destroy();
    for (const process of probes) process.kill('SIGKILL');
    // Await the upload finally blocks so no partial file or late commit remains.
    await Promise.allSettled(jobs.map(([, job]) => job.done));
  });
  app.addHook('onClose', async () => { clearInterval(expiry); tickets.clear(); });
  app.get('/api/library', async () => store.library());
  app.post('/api/library', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const device = requireRole(request, 'operator');
    assertDevice(device);
    if (uploads >= 2) throw new ApiFailure(503, 'Deux imports sont déjà en cours. Réessayez dans quelques instants.', 'LIBRARY_BUSY');
    if (!request.isMultipart()) throw new ApiFailure(400, 'Importez un fichier avec un formulaire multipart.', 'MEDIA_FILE_REQUIRED');
    uploads++;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const job = { streams: new Set<Readable>(), done, finish };
    uploadJobs.set(request.raw, job);
    const id = randomUUID(); const directory = path.join(store.dataDir, 'library');
    const temporary = path.join(directory, `.upload-${id}`);
    let destination: string | null = null;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const [directoryStat, dataRoot, libraryRoot] = await Promise.all([lstat(directory), realpath(store.dataDir), realpath(directory)]);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || path.relative(dataRoot, libraryRoot) !== 'library') throw new ApiFailure(503, 'Le dossier privé des médias doit être rétabli sur le PC.', 'LIBRARY_STORAGE_UNSAFE');
      await chmod(directory, 0o700);
      let filename = ''; let title = ''; let count = 0; let sizeBytes = 0;
      const digest = createHash('sha256');
      for await (const part of request.parts()) {
        assertOpen();
        if (part.type === 'field') {
          if (part.fieldname !== 'title' || title) throw new ApiFailure(400, 'Champ d’import non reconnu.');
          title = string(part.value, 'nom du média', 160);
          continue;
        }
        if (part.fieldname !== 'file' || ++count !== 1) throw new ApiFailure(400, 'Un seul fichier nommé « file » est requis.', 'MEDIA_FILE_REQUIRED');
        filename = path.basename(part.filename.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) || 'media';
        const measure = new Transform({ transform(chunk: Buffer, _encoding, next) {
          sizeBytes += chunk.length;
          if (sizeBytes > maximumLibraryBytes) { next(new ApiFailure(413, 'Le fichier dépasse la limite de 1 Go.', 'MEDIA_TOO_LARGE')); return; }
          digest.update(chunk); next(null, chunk);
        } });
        job.streams.add(part.file);
        try { await pipeline(part.file, measure, createWriteStream(temporary, { flags: 'wx', mode: 0o600 })); }
        finally { job.streams.delete(part.file); }
        if (part.file.truncated) throw new ApiFailure(413, 'Le fichier dépasse la limite de 1 Go.', 'MEDIA_TOO_LARGE');
      }
      if (count !== 1 || sizeBytes === 0) throw new ApiFailure(400, 'Choisissez un fichier non vide.', 'MEDIA_FILE_REQUIRED');
      const detected = await fileTypeFromFile(temporary).catch(() => undefined);
      assertOpen();
      const format = detected && formats[detected.mime];
      if (!detected || !format) throw new ApiFailure(415, 'Formats acceptés : images PNG/JPEG/GIF/WebP, vidéo, audio, PDF et PowerPoint PPTX. Les pages HTML, SVG et listes de lecture sont refusées.', 'MEDIA_FORMAT_UNSUPPORTED');
      const metadata = format.demuxer ? await probe(temporary, format.demuxer, probes) : { durationMs: null, width: null, height: null, hasVideo: false, hasAudio: false };
      if (format.kind === 'image' && !metadata.hasVideo || format.kind === 'video' && !metadata.hasVideo && !metadata.hasAudio || format.kind === 'audio' && !metadata.hasAudio) throw new ApiFailure(422, 'Ce fichier ne contient pas de média lisible.', 'MEDIA_PROBE_FAILED');
      const kind = format.kind === 'video' && !metadata.hasVideo && metadata.hasAudio ? 'audio' : format.kind;
      assertDevice(device);
      const fileName = `${id}.${format.extension}`;
      destination = path.join(directory, fileName);
      await rename(temporary, destination);
      const asset: MediaAsset = { id, title: title || filename.replace(/\.[^.]+$/, '').slice(0, 160) || 'Média sans titre', originalName: filename,
        kind, mimeType: detected.mime, sizeBytes, createdAt: new Date().toISOString(), archivedAt: null,
        durationMs: kind === 'image' || kind === 'document' ? null : metadata.durationMs, width: metadata.width, height: metadata.height };
      await studio.serial(() => { assertDevice(device); store.put<PrivateAsset>('mediaAsset', { id, asset, fileName, sha256: digest.digest('hex') }); studio.libraryChanged(); });
      destination = null;
      return reply.code(201).send(asset);
    } finally {
      uploads--;
      await rm(temporary, { force: true }).catch(() => undefined);
      if (destination) await rm(destination, { force: true }).catch(() => undefined);
      uploadJobs.delete(request.raw); finish();
    }
  });
  app.patch<{ Params: { id: string } }>('/api/library/:id', async request => {
    const device = requireRole(request, 'operator');
    const body = object(request.body);
    if (Object.keys(body).some(key => !['title', 'archived'].includes(key)) || !Object.keys(body).length || body.archived !== undefined && typeof body.archived !== 'boolean') throw new ApiFailure(400, 'Modification du média invalide.');
    const title = body.title === undefined ? undefined : string(body.title, 'nom du média', 160);
    return studio.serial(() => {
      assertDevice(device);
      const record = store.get<PrivateAsset>('mediaAsset', request.params.id);
      if (!record) throw mediaMissing();
      const asset = { ...record.asset, title: title ?? record.asset.title, archivedAt: body.archived === undefined ? record.asset.archivedAt : body.archived ? new Date().toISOString() : null };
      store.put('mediaAsset', { ...record, asset }); studio.libraryChanged(); return asset;
    });
  });
  app.put<{ Params: { id: string } }>('/api/projects/:id/media', async request => {
    const device = requireRole(request, 'operator'); const links = projectMediaInput(request.body);
    return studio.serial(() => {
      assertDevice(device); studio.project(request.params.id);
      const existing = store.get<{ id: string; links: { assetId: string }[] }>('projectMedia', request.params.id)?.links ?? [];
      for (const link of links) {
        const record = store.get<PrivateAsset>('mediaAsset', link.assetId);
        if (!record) throw mediaMissing();
        if (record.asset.archivedAt && !existing.some(item => item.assetId === link.assetId)) throw new ApiFailure(400, 'Restaurez ce média archivé avant de l’ajouter au projet.', 'MEDIA_ARCHIVED');
      }
      store.put('projectMedia', { id: request.params.id, links }); studio.libraryChanged(); return links;
    });
  });
  app.post<{ Params: { id: string } }>('/api/library/:id/file-ticket', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async request => {
    const device = request.device!;
    const { asset } = await libraryFile(store, request.params.id); assertDevice(device);
    const token = randomBytes(32).toString('base64url'); const expiresAt = Date.now() + 15 * 60_000;
    if (tickets.size >= 1000) tickets.delete(tickets.keys().next().value!);
    tickets.set(hashSecret(token), { assetId: asset.id, deviceId: device.id, expiresAt });
    return { url: `/api/library-files/${token}`, expiresAt: new Date(expiresAt).toISOString(), mimeType: asset.mimeType } satisfies FilePlaybackSession;
  });
  app.get<{ Params: { token: string } }>('/api/library-files/:token', async (request, reply) => {
    assertOpen();
    const ticket = /^[A-Za-z0-9_-]{43}$/.test(request.params.token) ? tickets.get(hashSecret(request.params.token)) : undefined;
    if (!ticket || ticket.expiresAt <= Date.now() || !store.device(ticket.deviceId)) throw new ApiFailure(401, 'Ce lien média a expiré ou l’appareil a été révoqué.', 'MEDIA_TICKET_EXPIRED');
    const { asset, file, fileStat } = await libraryFile(store, ticket.assetId);
    assertOpen();
    if (!store.device(ticket.deviceId)) throw new ApiFailure(401, 'L’accès de cet appareil a été révoqué.', 'UNAUTHENTICATED');
    return sendLibraryFile(asset, file, fileStat, request, reply, stream => monitor(stream, ticket.deviceId));
  });
}

function sendLibraryFile(asset: MediaAsset, file: string, fileStat: Stats, request: FastifyRequest, reply: FastifyReply, monitor: (stream: Readable) => void) {
  const filename = `${asset.title.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 100) || 'media'}${path.extname(file)}`;
  reply.type(asset.mimeType).header('Accept-Ranges', 'bytes').header('Cache-Control', 'no-store')
    .header('Content-Disposition', `${asset.kind === 'document' ? 'attachment' : 'inline'}; filename="${filename}"`);
  if (request.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    const start = match?.[1] ? +match[1] : Math.max(0, fileStat.size - +(match?.[2] ?? 0));
    const end = match?.[1] && match[2] ? Math.min(+match[2], fileStat.size - 1) : fileStat.size - 1;
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= fileStat.size) return reply.code(416).header('Content-Range', `bytes */${fileStat.size}`).send();
    const stream = createReadStream(file, { start, end }); monitor(stream);
    return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${fileStat.size}`).header('Content-Length', end - start + 1).send(stream);
  }
  const stream = createReadStream(file); monitor(stream);
  return reply.header('Content-Length', fileStat.size).send(stream);
}
