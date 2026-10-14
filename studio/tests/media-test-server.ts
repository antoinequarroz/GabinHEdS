import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FakeStreamService } from './fake-obs.js';
import type { MediaOptions } from '../apps/api/src/media.js';

/** Real media transport for bounded tests. It publishes a moving mire and a
 * sine wave, never cameras or microphones from the host. */
export async function startTestMedia(directory: string) {
  const binary = process.env.GABIN_MEDIAMTX_PATH ?? join(homedir(), '.cache/gabin-studio/mediamtx/v1.21.2', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
  if (!existsSync(binary)) throw new Error('MediaMTX manque pour la recette média : npm run setup:media.');
  const ffmpegPath = process.env.GABIN_FFMPEG_PATH ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
  const [apiPort, hlsPort, rtspPort, rtmpPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const configuration = join(directory, 'mediamtx-test.yml');
  await writeFile(configuration, `logLevel: warn
logDestinations: [stdout]
authMethod: internal
authInternalUsers:
  - user: any
    ips: [127.0.0.1, "::1"]
    permissions:
      - action: publish
      - action: read
      - action: api
api: true
apiAddress: 127.0.0.1:${apiPort}
rtsp: true
rtspAddress: 127.0.0.1:${rtspPort}
rtspTransports: [tcp]
rtmp: true
rtmpAddress: 127.0.0.1:${rtmpPort}
hls: true
hlsAddress: 127.0.0.1:${hlsPort}
hlsAlwaysRemux: true
hlsVariant: mpegts
hlsSegmentCount: 7
hlsSegmentDuration: 1s
webrtc: false
srt: false
moq: false
paths:
  all_others:
    source: publisher
    overridePublisher: false
`);
  const media = spawn(binary, [configuration], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  const capture = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-4000); };
  media.stdout.on('data', capture); media.stderr.on('data', capture);
  media.on('error', error => { logs += error.message; });
  let source: ChildProcess | null = null;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const paths = async () => {
    const response = await fetch(`${apiUrl}/v3/paths/list`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error(`MediaMTX ${response.status}`);
    return (await response.json() as { items: { name: string; ready: boolean }[] }).items;
  };
  try { await until(async () => { await paths(); return true; }, 10_000); }
  catch (error) { await stopChild(media); throw new Error(`${String(error)}\n${logs}`); }
  const options: MediaOptions = { apiUrl, hlsUrl: `http://127.0.0.1:${hlsPort}`, rtspUrl: `rtsp://127.0.0.1:${rtspPort}`,
    rtmpUrl: `rtmp://127.0.0.1:${rtmpPort}`, path: 'gabin/program', ffmpegPath, pollIntervalMs: 200 };
  return {
    options,
    destination: { name: 'Destination locale de recette', server: `rtmp://127.0.0.1:${rtmpPort}/gabin`, key: 'test-live' },
    async startSource(service: FakeStreamService) {
      if (source) throw new Error('La source de recette est déjà active.');
      const server = String(service.streamServiceSettings.server);
      const key = String(service.streamServiceSettings.key);
      assertLocal(server, rtmpPort);
      source = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
        '-f', 'flv', `${server.replace(/\/$/, '')}/${key}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      source.stdout?.resume(); source.stderr?.on('data', capture);
      source.on('error', error => { logs += error.message; });
      try { await until(async () => (await paths()).some(path => path.name === 'gabin/program' && path.ready), 10_000); }
      catch (error) {
        const child = source; source = null;
        if (child) await stopChild(child);
        throw new Error(`${String(error)}\n${logs}`);
      }
    },
    async stopSource() { if (source) { const child = source; source = null; await stopChild(child); } },
    async liveReady() {
      try { await until(async () => (await paths()).some(path => path.name === 'gabin/test-live' && path.ready), 5000); return true; }
      catch { console.info('Destination MediaMTX non prête', await paths()); return false; }
    },
    async close() {
      const child = source; source = null;
      try { if (child) await stopChild(child); }
      finally { await stopChild(media); }
    },
  };
}

function assertLocal(server: string, port: number) {
  const parsed = new URL(server);
  if (parsed.protocol !== 'rtmp:' || parsed.hostname !== '127.0.0.1' || Number(parsed.port) !== port) {
    throw new Error('Le test ne publie que vers son propre serveur local.');
  }
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port de recette indisponible.');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('close', resolve));
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
async function until(predicate: () => Promise<boolean>, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch { /* service may still be starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Le service média de recette n’a pas confirmé son état.');
}
