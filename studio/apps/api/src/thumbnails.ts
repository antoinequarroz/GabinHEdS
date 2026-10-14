import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ApiFailure } from './validation.js';

const formats: Record<string, string> = { '.mkv': 'matroska', '.webm': 'matroska', '.mp4': 'mov', '.mov': 'mov', '.m4v': 'mov', '.flv': 'flv', '.avi': 'avi', '.ts': 'mpegts' };
const maxBytes = 1024 * 1024;

/** Memory-only posters for completed recordings. No shell, disk output, network
 * input, or recording controls; the caller first resolves the authorized file. */
export class TakeThumbnails {
  private readonly cache = new Map<string, { data: Buffer; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<Buffer>>();
  private readonly children = new Set<ChildProcess>();
  private active = 0;
  private readonly waiting: { start(): void; cancel(): void }[] = [];
  private closed = false;
  constructor(private readonly ffmpeg = process.env.GABIN_FFMPEG_PATH ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg')) {}

  async image(file: string, modifiedAt: number, size: number): Promise<Buffer> {
    const format = formats[path.extname(file).toLowerCase()];
    if (!format) throw new ApiFailure(404, 'Ce format ne permet pas de créer une vignette.', 'THUMBNAIL_UNAVAILABLE');
    if (this.closed) throw new ApiFailure(503, 'Les vignettes sont momentanément indisponibles.', 'THUMBNAIL_UNAVAILABLE');
    const key = `${file}\0${modifiedAt}\0${size}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const promise = this.queuedCapture(file, format).then(data => {
      if (this.cache.size >= 48) this.cache.delete(this.cache.keys().next().value!);
      if (!this.closed) this.cache.set(key, { data, expiresAt: Date.now() + 5 * 60_000 });
      return data;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private async queuedCapture(file: string, format: string): Promise<Buffer> {
    await this.acquireSlot();
    try {
      if (this.closed) throw new ApiFailure(503, 'Les vignettes sont momentanément indisponibles.', 'THUMBNAIL_UNAVAILABLE');
      return await this.capture(file, format);
    } finally {
      this.active--;
      this.waiting.shift()?.start();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < 2) { this.active++; return; }
    if (this.waiting.length >= 16) throw new ApiFailure(503, 'La vignette sera disponible dans quelques secondes.', 'THUMBNAIL_UNAVAILABLE');
    return new Promise((resolve, reject) => {
      const entry = {
        start: () => { clearTimeout(timer); this.active++; resolve(); },
        cancel: () => { clearTimeout(timer); reject(new ApiFailure(503, 'La vignette sera disponible dans quelques secondes.', 'THUMBNAIL_UNAVAILABLE')); },
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        entry.cancel();
      }, 6000);
      timer.unref();
      this.waiting.push(entry);
    });
  }

  private capture(file: string, format: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // Selecting the demuxer excludes disguised playlists which might reference
      // other files. FFmpeg is further restricted to local file/pipe protocols.
      const child = spawn(this.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1',
        '-protocol_whitelist', 'file,pipe', '-f', format, '-i', file, '-map', '0:v:0', '-an', '-frames:v', '1',
        '-vf', 'scale=480:270:force_original_aspect_ratio=decrease', '-threads', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
      this.children.add(child);
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failed = false;
      const unavailable = () => new ApiFailure(503, 'Impossible de lire une image de cette prise.', 'THUMBNAIL_UNAVAILABLE');
      const failure = () => {
        if (failed) return;
        failed = true;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(failure, 5000);
      timer.unref();
      child.stdout!.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) failure();
        else chunks.push(chunk);
      });
      child.once('error', failure);
      child.once('close', code => {
        clearTimeout(timer);
        this.children.delete(child);
        // Release the concurrency slot only after the killed process has exited.
        if (failed) { reject(unavailable()); return; }
        const data = Buffer.concat(chunks);
        if (code !== 0 || data.length < 4 || data.readUInt16BE(0) !== 0xffd8) { reject(unavailable()); return; }
        resolve(data);
      });
    });
  }

  close(): void {
    this.closed = true;
    for (const entry of this.waiting.splice(0)) entry.cancel();
    for (const child of this.children) child.kill('SIGKILL');
    this.cache.clear();
  }
}
