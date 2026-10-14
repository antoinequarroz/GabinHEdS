import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { ZipFile } from 'yazl';
import type { Device, DeviceRole, DownloadTicket, FilePlaybackSession, MediaAsset, Project, ProjectMediaLink, Take, TakePlaybackStatus } from '@gabin/shared';
import { libraryFile } from './library.js';
import { hashSecret, type Store } from './store.js';
import type { Studio } from './studio.js';
import { ApiFailure, object } from './validation.js';
import { sameFile, takeFileKey, TakePlayback, type PlaybackFile, type ResolvedTakeFile } from './take-playback.js';

export interface ProductionFileRouteOptions {
  store: Store;
  studio: Pick<Studio, 'project' | 'state'>;
  requireRole(request: FastifyRequest, minimum: DeviceRole): Device;
  resolveTakeFile(takeId: string): Promise<ResolvedTakeFile>;
  resolveLibraryFile?: typeof libraryFile;
  playback?: ConstructorParameters<typeof TakePlayback>[1];
}
interface PlaybackTicket { deviceId: string; takeId: string; preferMp4: boolean; sourceKey: string; playback: PlaybackFile; expiresAt: number; }
interface ExportTicket { deviceId: string; projectId: string; expiresAt: number; }
interface ArchiveFile { file: string; fileStat: Stats; archivePath: string; type: 'take' | 'media'; id: string; title: string; mimeType?: string; sha256?: string; }
interface ExportPlan { project: Project; takes: Take[]; links: ProjectMediaLink[]; assets: MediaAsset[]; files: ArchiveFile[]; }
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const slug = (value: string): string => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 65) || 'production';
const suffix = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 12);
const safeExtension = (file: string): string => /^\.[A-Za-z0-9]{1,10}$/.test(path.extname(file)) ? path.extname(file).toLowerCase() : '.bin';
const safeOriginalName = (file: string): string => path.basename(file.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Native media requests use revocable, short lived device-bound tickets. The
 * surrounding app provides the authenticated creation routes and origin gate. */
export function registerProductionFileRoutes(app: FastifyInstance, options: ProductionFileRouteOptions): void {
  const { store, studio, requireRole, resolveTakeFile } = options;
  const resolveLibraryFile = options.resolveLibraryFile ?? libraryFile;
  const playback = new TakePlayback(store.dataDir, options.playback);
  const playbackTickets = new Map<string, PlaybackTicket>();
  const exportTickets = new Map<string, ExportTicket>();
  const transfers = new Set<Readable>();
  let closing = false;
  const authorized = (id: string): boolean => { try { return !closing && !!store.device(id); } catch { return false; } };
  const assertDevice = (id: string): void => { if (!authorized(id)) throw new ApiFailure(401, 'L’accès de cet appareil a été révoqué ou a expiré.', 'UNAUTHENTICATED'); };
  const trim = <T extends { expiresAt: number; deviceId: string }>(tickets: Map<string, T>, removed?: (ticket: T) => void): void => {
    const remove = (key: string, ticket: T) => { tickets.delete(key); removed?.(ticket); };
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= Date.now() || !authorized(ticket.deviceId)) remove(key, ticket);
    while (tickets.size >= 512) { const [key, ticket] = tickets.entries().next().value!; remove(key, ticket); }
  };
  const prune = setInterval(() => { trim(playbackTickets, ticket => playback.unpin(ticket.playback.file)); trim(exportTickets); }, 30_000);
  prune.unref();

  const projectIdle = (id: string): void => {
    const current = studio.state();
    if (current.activeTake?.projectId === id || current.liveProjectId === id || store.setting<Take>('pendingTake')?.projectId === id
      || store.takes().some(take => take.projectId === id && ['recording', 'paused'].includes(take.status))) {
      throw new ApiFailure(409, 'Terminez et vérifiez la prise et le direct de cette production avant de récupérer le dossier complet.', 'PRODUCTION_ACTIVE');
    }
  };

  const exportPlan = async (projectId: string): Promise<ExportPlan> => {
    const project = studio.project(projectId);
    projectIdle(projectId);
    const takes = store.takes().filter(take => take.projectId === projectId).sort((a, b) => a.sequence - b.sequence);
    const completed = takes.filter(take => take.status === 'completed');
    if (!completed.length) throw new ApiFailure(409, 'Cette production ne contient pas encore de prise terminée.', 'NO_COMPLETED_TAKE');
    const links = store.get<{ id: string; links: ProjectMediaLink[] }>('projectMedia', projectId)?.links ?? [];
    if (completed.length + links.length > 2000) throw new ApiFailure(413, 'Cette production contient trop de fichiers pour un seul export.', 'EXPORT_TOO_MANY_FILES');
    const files: ArchiveFile[] = [];
    for (const [index, take] of completed.entries()) {
      let resolved: ResolvedTakeFile;
      try { resolved = await resolveTakeFile(take.id); }
      catch (error) {
        if (error instanceof ApiFailure && error.statusCode === 403) throw error;
        throw new ApiFailure(409, `Le fichier de « ${take.title} » est introuvable. Le dossier complet ne peut pas être créé.`, 'MISSING_PRODUCTION_FILE');
      }
      files.push({ ...resolved, archivePath: `takes/${String(index + 1).padStart(3, '0')}-${slug(take.title)}-${suffix(take.id)}${safeExtension(resolved.file)}`,
        type: 'take', id: take.id, title: take.title });
    }
    const assets: MediaAsset[] = [];
    for (const id of [...new Set(links.map(link => link.assetId))]) {
      let resolved: Awaited<ReturnType<typeof libraryFile>>;
      try { resolved = await resolveLibraryFile(store, id); }
      catch (error) {
        if (error instanceof ApiFailure && error.statusCode === 403) throw error;
        throw new ApiFailure(409, 'Un média associé à cette production est introuvable. Rétablissez-le avant de récupérer le dossier complet.', 'MISSING_PRODUCTION_FILE');
      }
      assets.push(resolved.asset);
      files.push({ file: resolved.file, fileStat: resolved.fileStat,
        archivePath: `media/${String(assets.length).padStart(3, '0')}-${slug(resolved.asset.title)}-${suffix(id)}${safeExtension(resolved.file)}`,
        type: 'media', id, title: resolved.asset.title, mimeType: resolved.asset.mimeType });
    }
    projectIdle(projectId);
    return { project, takes, links, assets, files };
  };

  const monitorTransfer = (stream: Readable, deviceId: string, valid?: () => void): void => {
    try { assertDevice(deviceId); valid?.(); }
    catch (error) { stream.destroy(); throw error; }
    transfers.add(stream);
    const guard = setInterval(() => {
      try { assertDevice(deviceId); valid?.(); }
      catch (error) { stream.destroy(error instanceof Error ? error : new Error('Transfer no longer authorized')); }
    }, 1000);
    guard.unref();
    const complete = () => { clearInterval(guard); transfers.delete(stream); };
    stream.once('end', complete); stream.once('close', complete);
  };

  app.post<{ Params: { id: string } }>('/api/takes/:id/playback-session', { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (request, reply): Promise<TakePlaybackStatus> => {
    const device = requireRole(request, 'viewer');
    const body = request.body === undefined ? {} : object(request.body);
    if (Object.keys(body).some(key => key !== 'mimeType') || body.mimeType !== undefined && body.mimeType !== 'video/mp4') {
      throw new ApiFailure(400, 'Le format de lecture demandé est invalide.', 'INVALID_PLAYBACK_FORMAT');
    }
    const preferMp4 = body.mimeType === 'video/mp4';
    const source = await resolveTakeFile(request.params.id);
    assertDevice(device.id);
    const job = playback.request(source, preferMp4);
    if (job.status === 'failed') return { status: 'failed', error: job.error };
    if (job.status === 'preparing' || !job.result) { reply.code(202); return { status: 'preparing' }; }
    try { await playback.verify(job.result, source); }
    catch (error) {
      if (!(error instanceof ApiFailure) || error.statusCode !== 404) throw error;
      playback.forget(source, preferMp4); playback.request(source, preferMp4);
      reply.code(202); return { status: 'preparing' };
    }
    assertDevice(device.id);
    trim(playbackTickets, ticket => playback.unpin(ticket.playback.file));
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 2 * 3600_000;
    playbackTickets.set(hashSecret(token), { deviceId: device.id, takeId: source.take.id, preferMp4, sourceKey: takeFileKey(source, preferMp4), playback: job.result, expiresAt });
    playback.pin(job.result.file);
    const session: FilePlaybackSession = { url: `/api/playback-files/${token}`, expiresAt: new Date(expiresAt).toISOString(), mimeType: job.result.mimeType };
    return { status: 'ready', session };
  });

  app.route<{ Params: { token: string } }>({ method: ['GET', 'HEAD'], url: '/api/playback-files/:token', handler: async (request, reply) => {
    const ticket = tokenPattern.test(request.params.token) ? playbackTickets.get(hashSecret(request.params.token)) : undefined;
    if (!ticket || ticket.expiresAt <= Date.now()) throw new ApiFailure(401, 'Cette session de lecture a expiré.', 'PLAYBACK_EXPIRED');
    assertDevice(ticket.deviceId);
    const source = await resolveTakeFile(ticket.takeId);
    if (takeFileKey(source, ticket.preferMp4) !== ticket.sourceKey) throw new ApiFailure(409, 'Le fichier original a changé. Rouvrez cette prise.', 'PLAYBACK_SOURCE_CHANGED');
    await playback.verify(ticket.playback, source);
    assertDevice(ticket.deviceId);
    return sendVideo(ticket.playback, source.take.title, request, reply, stream => monitorTransfer(stream, ticket.deviceId));
  } });

  app.post<{ Params: { id: string } }>('/api/projects/:id/export-ticket', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request): Promise<DownloadTicket> => {
    const device = requireRole(request, 'viewer');
    await exportPlan(request.params.id);
    assertDevice(device.id);
    trim(exportTickets);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 5 * 60_000;
    exportTickets.set(hashSecret(token), { deviceId: device.id, projectId: request.params.id, expiresAt });
    return { url: `/api/production-exports/${token}`, expiresAt: new Date(expiresAt).toISOString() };
  });

  app.route<{ Params: { token: string } }>({ method: ['GET', 'HEAD'], url: '/api/production-exports/:token', handler: async (request, reply) => {
    const ticket = tokenPattern.test(request.params.token) ? exportTickets.get(hashSecret(request.params.token)) : undefined;
    if (!ticket || ticket.expiresAt <= Date.now()) throw new ApiFailure(401, 'Ce lien d’export a expiré.', 'DOWNLOAD_EXPIRED');
    assertDevice(ticket.deviceId);
    const plan = await exportPlan(ticket.projectId);
    assertDevice(ticket.deviceId);
    reply.type('application/zip').header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="${slug(plan.project.title)}.zip"; filename*=UTF-8''${encodeURIComponent(plan.project.title + '.zip')}`);
    if (request.method === 'HEAD') return reply.send();
    const stream = productionZip(plan, store, () => { assertDevice(ticket.deviceId); projectIdle(ticket.projectId); });
    monitorTransfer(stream, ticket.deviceId, () => projectIdle(ticket.projectId));
    return reply.send(stream);
  } });

  app.addHook('preClose', async () => {
    closing = true;
    for (const stream of transfers) stream.destroy();
    await playback.close();
  });
  app.addHook('onClose', async () => {
    clearInterval(prune); playbackTickets.clear(); exportTickets.clear();
  });
}

async function openVerified(file: string, expected: Stats) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw new ApiFailure(404, 'Le fichier n’est plus disponible.', 'FILE_NOT_FOUND'); });
  try {
    if (!sameFile(await handle.stat(), expected)) throw new ApiFailure(409, 'Le fichier a changé depuis la vérification.', 'FILE_CHANGED');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function sendVideo(playback: PlaybackFile, title: string, request: FastifyRequest, reply: FastifyReply, monitor: (stream: Readable) => void) {
  const total = playback.fileStat.size;
  reply.type(playback.mimeType).header('Cache-Control', 'no-store').header('Accept-Ranges', 'bytes')
    .header('Content-Disposition', `inline; filename="${slug(title)}${playback.mimeType === 'video/webm' ? '.webm' : '.mp4'}"`);
  let start = 0, end = total - 1;
  if (request.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (!range || !range[1] && !range[2]) return reply.code(416).header('Content-Range', `bytes */${total}`).send();
    start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= total || !range[1] && Number(range[2]) <= 0) {
      return reply.code(416).header('Content-Range', `bytes */${total}`).send();
    }
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${total}`);
  }
  reply.header('Content-Length', end - start + 1);
  if (request.method === 'HEAD') return reply.send();
  const handle = await openVerified(playback.file, playback.fileStat);
  const stream = handle.createReadStream({ start, end, autoClose: true });
  monitor(stream);
  return reply.send(stream);
}

function productionZip(plan: ExportPlan, store: Store, valid: () => void): Readable {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const readers = new Set<Readable>();
  zip.on('error', error => output.destroy(error));
  output.once('close', () => { for (const reader of readers) reader.destroy(); });
  const completedIds = new Set(plan.takes.filter(take => take.status === 'completed').map(take => take.id));
  const project = { id: plan.project.id, title: plan.project.title, description: plan.project.description, owner: plan.project.owner,
    format: plan.project.format, participants: plan.project.participants, defaultScene: plan.project.defaultScene,
    status: plan.project.status, createdAt: plan.project.createdAt, updatedAt: plan.project.updatedAt, media: plan.links };
  const takes = plan.takes.map(take => ({ id: take.id, sequence: take.sequence, title: take.title, status: take.status,
    startedAt: take.startedAt, endedAt: take.endedAt, durationMs: take.durationMs,
    file: plan.files.find(file => file.type === 'take' && file.id === take.id)?.archivePath ?? null,
    ...(take.status === 'interrupted' ? { warning: 'Prise interrompue : fichier non validé, non inclus comme prise terminée.' } : {}) }));
  const markers = store.markers().filter(marker => plan.takes.some(take => take.id === marker.takeId));
  const csv = (value: string | number) => {
    let text = String(value);
    if (typeof value === 'string' && /^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  zip.addBuffer(json(project), 'project.json');
  zip.addBuffer(json({ markers }), 'markers.json');
  zip.addBuffer(Buffer.from(`take_id,take_title,offset_ms,label,created_at\r\n${markers.map(marker =>
    [marker.takeId, plan.takes.find(take => take.id === marker.takeId)?.title ?? '', marker.offsetMs, marker.label, marker.createdAt].map(csv).join(',')).join('\r\n')}\r\n`), 'markers.csv');
  zip.addBuffer(Buffer.from(`DOSSIER DE PRODUCTION NINO\n\nLes prises validées complètes sont dans takes/, dans leur format et qualité d’origine.\nLes médias associés sont dans media/. Aucun montage ni enregistrement n’a été remplacé.\nproject.json décrit la production ; markers.json et markers.csv contiennent les repères.\nmanifest.json liste les fichiers, leurs chemins relatifs et leurs empreintes SHA-256.\nLes prises interrompues y sont signalées et ne sont pas présentées comme terminées.\nLes copies temporaires de lecture navigateur ne sont pas incluses.\nLe dossier peut être déplacé sans dépendre des chemins du PC de la salle.\n`), 'README.txt');
  for (const file of plan.files) zip.addReadStreamLazy(file.archivePath, { size: file.fileStat.size, mtime: file.fileStat.mtime, mode: 0o100644, compress: false, forceZip64Format: true }, callback => {
    void (async () => {
      valid();
      const handle = await openVerified(file.file, file.fileStat);
      if (output.destroyed) { await handle.close(); throw new Error('Export cancelled'); }
      try { valid(); } catch (error) { await handle.close(); throw error; }
      const input = handle.createReadStream({ autoClose: true });
      const hash = createHash('sha256');
      const hasher = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); done(null, chunk); },
        flush(done) {
          void stat(file.file).then(info => {
            valid();
            if (!sameFile(info, file.fileStat)) throw new Error('File changed while exporting');
            file.sha256 = hash.digest('hex'); done();
          }).catch(error => done(error instanceof Error ? error : new Error('Export failed')));
        } });
      readers.add(input); readers.add(hasher);
      input.once('error', error => hasher.destroy(error));
      hasher.once('error', error => { input.destroy(); output.destroy(error); });
      input.once('close', () => readers.delete(input)); hasher.once('close', () => readers.delete(hasher));
      callback(null, input.pipe(hasher));
    })().catch(error => callback(error, Readable.from([])));
  });
  // This lazy final entry is created after all original streams have finished,
  // so checksums are computed in one pass without buffering or rereading video.
  zip.addReadStreamLazy('manifest.json', callback => {
    try {
      valid();
      callback(null, Readable.from(json({ schemaVersion: 1, exportedAt: new Date().toISOString(), projectId: plan.project.id,
        complete: plan.takes.every(take => take.status === 'completed'), filesVerified: true,
        scope: 'completed_original_takes_and_linked_media', completedTakeCount: completedIds.size, takes,
        media: plan.assets.map(asset => ({ id: asset.id, title: asset.title, originalName: safeOriginalName(asset.originalName),
          kind: asset.kind, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, archivedAt: asset.archivedAt,
          file: plan.files.find(file => file.type === 'media' && file.id === asset.id)?.archivePath })),
        files: plan.files.map(file => ({ id: file.id, type: file.type, title: file.title, path: file.archivePath,
          sizeBytes: file.fileStat.size, sha256: file.sha256 })) })));
    } catch (error) { callback(error, Readable.from([])); }
  });
  zip.end({ forceZip64Format: true, comment: 'Nino production originals' });
  return output;
}
