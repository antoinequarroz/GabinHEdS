import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, type Stats } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { Take } from '@gabin/shared';
import { ApiFailure } from './validation.js';

export interface ResolvedTakeFile { take: Take; file: string; fileStat: Stats; }
export interface PlaybackFile { file: string; fileStat: Stats; mimeType: string; sourceKey: string; }
type PlaybackJob = { status: 'preparing' | 'ready' | 'failed'; source: ResolvedTakeFile; preferMp4: boolean;
  lastUsedAt: number; result?: PlaybackFile; error?: string; promise?: Promise<void> };
interface ProbeStream { codec_type?: string; codec_name?: string; pix_fmt?: string; }
interface ProbeResult { streams?: ProbeStream[]; format?: { duration?: string }; }
const demuxers: Record<string, string> = { '.mkv': 'matroska', '.webm': 'matroska', '.mp4': 'mov', '.m4v': 'mov', '.mov': 'mov',
  '.flv': 'flv', '.avi': 'avi', '.ts': 'mpegts', '.mts': 'mpegts', '.ogv': 'ogg', '.wmv': 'asf' };
const retentionMs = 7 * 24 * 3600_000;
const minimumFreeBytes = 1024 ** 3;
const safeCacheName = /^[a-f0-9]{64}\.mp4$/;
const safePartialName = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.partial\.mp4$/;

export function takeFileKey(source: ResolvedTakeFile, preferMp4 = true): string {
  return createHash('sha256').update(JSON.stringify([source.take.id, source.file, source.fileStat.size,
    source.fileStat.mtimeMs, source.fileStat.ino, source.fileStat.dev, preferMp4])).digest('hex');
}
export function sameFile(a: Stats, b: Stats): boolean {
  return a.isFile() && b.isFile() && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;
}

/** Completed recordings remain immutable. Compatibility copies live only in
 * the private runtime cache; one worker and a bounded queue protect the studio. */
export class TakePlayback {
  private readonly jobs = new Map<string, PlaybackJob>();
  private readonly queue: PlaybackJob[] = [];
  private readonly children = new Set<ChildProcess>();
  private readonly activeFiles = new Set<string>();
  private readonly protectedFiles = new Map<string, number>();
  private active: PlaybackJob | null = null;
  private closed = false;
  private directoryPromise: Promise<string> | null = null;
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly maxCacheBytes: number;
  private readonly conversionTimeoutMs: number;

  constructor(private readonly dataDir: string, options: { ffmpegPath?: string; ffprobePath?: string; cacheMaxBytes?: number; conversionTimeoutMs?: number } = {}) {
    this.ffmpeg = options.ffmpegPath ?? process.env.GABIN_FFMPEG_PATH ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
    this.ffprobe = options.ffprobePath ?? process.env.GABIN_FFPROBE_PATH
      ?? (path.isAbsolute(this.ffmpeg) ? path.join(path.dirname(this.ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
    const configuredLimit = options.cacheMaxBytes ?? Number(process.env.GABIN_PLAYBACK_CACHE_MAX_BYTES);
    this.maxCacheBytes = Number.isSafeInteger(configuredLimit) && configuredLimit >= 1024 * 1024 ? configuredLimit : 20 * 1024 ** 3;
    this.conversionTimeoutMs = options.conversionTimeoutMs ?? 30 * 60_000;
  }

  request(source: ResolvedTakeFile, preferMp4: boolean): PlaybackJob {
    if (this.closed) throw new ApiFailure(503, 'La lecture est momentanément indisponible.', 'PLAYBACK_UNAVAILABLE');
    const key = takeFileKey(source, preferMp4);
    const known = this.jobs.get(key);
    if (known) { known.lastUsedAt = Date.now(); return known; }
    // Polling can retry admission without creating unbounded pending work.
    if (this.queue.length >= 8) return { status: 'preparing', source, preferMp4, lastUsedAt: Date.now() };
    if (this.jobs.size >= 64) {
      const oldest = [...this.jobs].filter(([, job]) => job.status !== 'preparing').sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (oldest) this.jobs.delete(oldest[0]);
    }
    const job: PlaybackJob = { status: 'preparing', source, preferMp4, lastUsedAt: Date.now() };
    this.jobs.set(key, job);
    this.queue.push(job);
    this.pump();
    return job;
  }

  pin(file: string): void { this.protectedFiles.set(file, (this.protectedFiles.get(file) ?? 0) + 1); }
  unpin(file: string): void {
    const count = this.protectedFiles.get(file) ?? 0;
    if (count <= 1) this.protectedFiles.delete(file); else this.protectedFiles.set(file, count - 1);
  }
  forget(source: ResolvedTakeFile, preferMp4: boolean): void { this.jobs.delete(takeFileKey(source, preferMp4)); }
  async verify(result: PlaybackFile, source: ResolvedTakeFile): Promise<void> {
    if (result.file !== source.file) {
      const directory = await this.directory();
      if (path.dirname(result.file) !== directory || !safeCacheName.test(path.basename(result.file))
        || await realpath(result.file).catch(() => '') !== result.file) throw new ApiFailure(404, 'La copie de lecture n’est plus disponible.', 'PLAYBACK_UNAVAILABLE');
    }
    const info = await lstat(result.file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || !sameFile(info, result.fileStat)) throw new ApiFailure(404, 'La copie de lecture n’est plus disponible.', 'PLAYBACK_UNAVAILABLE');
  }

  private pump(): void {
    if (this.closed || this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    job.promise = this.prepare(job).then(result => { job.result = result; job.status = 'ready'; }).catch(error => {
      job.status = 'failed';
      job.error = error instanceof ApiFailure ? error.message : 'Impossible de préparer cette vidéo. Le fichier original reste disponible au téléchargement.';
    }).finally(() => { this.active = null; this.pump(); });
  }

  private async directory(): Promise<string> {
    if (!this.directoryPromise) this.directoryPromise = (async () => {
      const root = await realpath(this.dataDir);
      const expected = path.join(root, 'playback');
      await mkdir(expected, { recursive: true, mode: 0o700 });
      const directory = await realpath(expected);
      if (directory !== expected || (await lstat(expected)).isSymbolicLink()) {
        throw new ApiFailure(403, 'Le dossier privé de lecture n’est pas valide.', 'PLAYBACK_CACHE_UNSAFE');
      }
      await this.prune(directory, 0);
      return directory;
    })();
    const directory = await this.directoryPromise;
    if (await realpath(directory).catch(() => '') !== directory || (await lstat(directory)).isSymbolicLink()) {
      throw new ApiFailure(403, 'Le dossier privé de lecture a été remplacé. Vérifiez son emplacement sur le PC.', 'PLAYBACK_CACHE_UNSAFE');
    }
    return directory;
  }

  private async prune(directory: string, reserve: number): Promise<void> {
    const files: { name: string; size: number; modified: number }[] = [];
    for (const name of await readdir(directory)) {
      if (!safeCacheName.test(name) && !safePartialName.test(name)) continue;
      const file = path.join(directory, name);
      if (this.activeFiles.has(file)) continue;
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      if ((Date.now() - info.mtimeMs > retentionMs || safePartialName.test(name)) && !this.protectedFiles.has(file)) await rm(file, { force: true });
      else files.push({ name, size: info.size, modified: info.mtimeMs });
    }
    let bytes = files.reduce((total, file) => total + file.size, 0);
    for (const file of files.sort((a, b) => a.modified - b.modified)) {
      if (bytes + reserve <= this.maxCacheBytes) break;
      if (this.protectedFiles.has(path.join(directory, file.name))) continue;
      await rm(path.join(directory, file.name), { force: true });
      bytes -= file.size;
    }
    if (bytes + reserve > this.maxCacheBytes) throw new ApiFailure(507,
      'Le cache de lecture est utilisé par d’autres vidéos. Fermez leurs lecteurs ou téléchargez le fichier original.', 'PLAYBACK_CACHE_FULL');
  }

  private async cacheBytes(directory: string): Promise<number> {
    let bytes = 0;
    for (const name of await readdir(directory)) {
      if (!safeCacheName.test(name)) continue;
      const info = await lstat(path.join(directory, name)).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) bytes += info.size;
    }
    return bytes;
  }

  private async prepare(job: PlaybackJob): Promise<PlaybackFile> {
    const { source } = job;
    const extension = path.extname(source.file).toLowerCase();
    const format = demuxers[extension];
    if (!format) throw new ApiFailure(415, 'Ce format ne permet pas une lecture dans le navigateur. Téléchargez le fichier original.', 'PLAYBACK_FORMAT_UNSUPPORTED');
    await this.confirmSource(source);
    const directory = await this.directory();
    const sourceKey = takeFileKey(source, job.preferMp4);
    const cached = path.join(directory, `${sourceKey}.mp4`);
    const cachedStat = await lstat(cached).catch(() => null);
    if (cachedStat?.isFile() && !cachedStat.isSymbolicLink() && cachedStat.size > 0) {
      return { file: cached, fileStat: cachedStat, mimeType: 'video/mp4', sourceKey };
    }
    await this.confirmSource(source);
    const data = await this.run(this.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', format,
      '-show_entries', 'stream=codec_type,codec_name,pix_fmt:format=duration', '-of', 'json', source.file], 10_000, 128 * 1024);
    let probe: ProbeResult;
    try { probe = JSON.parse(data.toString()) as ProbeResult; } catch { throw new Error('Invalid probe output'); }
    const video = probe.streams?.find(stream => stream.codec_type === 'video');
    const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
    if (!video) throw new ApiFailure(415, 'Cette prise ne contient pas de piste vidéo lisible.', 'PLAYBACK_FORMAT_UNSUPPORTED');
    const h264 = video.codec_name === 'h264' && (!video.pix_fmt || ['yuv420p', 'yuvj420p'].includes(video.pix_fmt));
    const mp4Audio = !audio || audio.codec_name === 'aac';
    const webm = ['vp8', 'vp9'].includes(video.codec_name ?? '') && (!audio || ['opus', 'vorbis'].includes(audio.codec_name ?? ''));
    if (extension === '.mp4' && h264 && mp4Audio || extension === '.webm' && webm && !job.preferMp4) {
      await this.confirmSource(source);
      return { file: source.file, fileStat: source.fileStat, mimeType: extension === '.webm' ? 'video/webm' : 'video/mp4', sourceKey };
    }
    if (source.fileStat.size > this.maxCacheBytes) throw new ApiFailure(507,
      'Cette vidéo dépasse la capacité du cache de lecture. Téléchargez le fichier original.', 'PLAYBACK_CACHE_FULL');
    await this.prune(directory, source.fileStat.size);
    const capacity = await statfs(directory);
    const freeBytes = capacity.bavail * capacity.bsize;
    if (freeBytes < source.fileStat.size + minimumFreeBytes) throw new ApiFailure(507,
      'Espace disque insuffisant pour préparer la lecture. Le fichier original reste disponible.', 'PLAYBACK_CACHE_FULL');
    const outputBudget = Math.floor(Math.min(this.maxCacheBytes - await this.cacheBytes(directory), freeBytes - minimumFreeBytes));
    const partial = path.join(directory, `${sourceKey}.${randomUUID()}.partial.mp4`);
    this.activeFiles.add(partial);
    try {
      await this.confirmSource(source);
      const videoOptions = h264 ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"];
      await this.run(this.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-threads', '2',
        '-protocol_whitelist', 'file,pipe', '-f', format, '-i', source.file, '-map', '0:v:0', '-map', '0:a:0?',
        ...videoOptions, ...(!audio || mp4Audio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']),
        '-threads', '2', '-movflags', '+faststart', '-fs', String(outputBudget), '-f', 'mp4', partial], this.conversionTimeoutMs, 1024 * 1024, partial, outputBudget);
      await this.confirmSource(source);
      const info = await lstat(partial);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > outputBudget) throw new ApiFailure(507,
        'La copie de lecture dépasse l’espace disponible. Téléchargez le fichier original.', 'PLAYBACK_CACHE_FULL');
      const completed = JSON.parse((await this.run(this.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'mov',
        '-show_entries', 'format=duration', '-of', 'json', partial], 10_000, 128 * 1024)).toString()) as ProbeResult;
      const expectedDuration = Number(probe.format?.duration) || source.take.durationMs / 1000;
      const actualDuration = Number(completed.format?.duration);
      if (!Number.isFinite(actualDuration) || actualDuration <= 0 || expectedDuration > 0 && actualDuration + Math.min(1, Math.max(.25, expectedDuration * .0001)) < expectedDuration) {
        throw new ApiFailure(507, 'La préparation n’a pas conservé la vidéo entière. Téléchargez le fichier original.', 'PLAYBACK_INCOMPLETE');
      }
      await this.directory();
      await this.prune(directory, info.size);
      await rename(partial, cached);
      return { file: cached, fileStat: await stat(cached), mimeType: 'video/mp4', sourceKey };
    } finally { this.activeFiles.delete(partial); await rm(partial, { force: true }).catch(() => undefined); }
  }

  private async confirmSource(source: ResolvedTakeFile): Promise<void> {
    const [resolved, info] = await Promise.all([realpath(source.file), lstat(source.file)]);
    if (this.closed || resolved !== source.file || info.isSymbolicLink() || !sameFile(source.fileStat, info)) {
      throw new ApiFailure(409, 'Le fichier original a changé. Rouvrez la prise pour vérifier son état.', 'PLAYBACK_SOURCE_CHANGED');
    }
  }

  private run(binary: string, args: string[], timeoutMs: number, outputLimit: number, outputFile?: string, outputBudget = this.maxCacheBytes): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('Playback closed')); return; }
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.children.add(child);
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: Error | null = null;
      const fail = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
      const timer = setTimeout(() => fail(new ApiFailure(503, 'La préparation vidéo a dépassé le délai prévu. Téléchargez le fichier original.', 'PLAYBACK_TIMEOUT')), timeoutMs);
      timer.unref();
      let checking = false;
      const sizeTimer = outputFile ? setInterval(() => {
        if (checking) return;
        checking = true;
        void (async () => {
          const directory = await this.directory();
          const info = await lstat(outputFile).catch(() => null);
          if (info && (info.size > outputBudget || info.size + await this.cacheBytes(directory) > this.maxCacheBytes)) {
            throw new ApiFailure(507, 'La copie de lecture dépasse la capacité du cache. Téléchargez le fichier original.', 'PLAYBACK_CACHE_FULL');
          }
          const capacity = await statfs(directory);
          if (capacity.bavail * capacity.bsize < minimumFreeBytes) throw new ApiFailure(507,
            'La préparation est arrêtée pour conserver de l’espace disque dans la salle. Téléchargez le fichier original.', 'PLAYBACK_CACHE_FULL');
        })().catch(error => fail(error instanceof Error ? error : new Error('Playback storage check failed'))).finally(() => { checking = false; });
      }, 500) : null;
      sizeTimer?.unref();
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > outputLimit) fail(new Error('Output limit')); else chunks.push(chunk); });
      child.stderr.resume();
      child.once('error', fail);
      child.once('close', code => {
        clearTimeout(timer); if (sizeTimer) clearInterval(sizeTimer); this.children.delete(child);
        if (failure || code !== 0 || this.closed) reject(failure ?? new Error('Video preparation failed'));
        else resolve(Buffer.concat(chunks));
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.splice(0);
    for (const child of this.children) child.kill('SIGKILL');
    await this.active?.promise;
    this.jobs.clear(); this.protectedFiles.clear();
  }
}
