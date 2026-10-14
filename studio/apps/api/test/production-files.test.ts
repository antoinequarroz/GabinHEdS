import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import type { AuthResult, DownloadTicket, FilePlaybackSession, MediaAsset, Project, Take, TakePlaybackStatus } from '@gabin/shared';
import { buildApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { emptyMediaState, type MediaGateway } from '../src/media.js';
import { TakePlayback } from '../src/take-playback.js';

const ffmpeg = process.env.GABIN_FFMPEG_PATH ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const run = promisify(execFile);
const checksum = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');
const fixtureMedia = (): MediaGateway => ({ getState: emptyMediaState, refresh: async () => emptyMediaState(),
  ingestSettings: () => ({ server: 'rtmp://127.0.0.1:1935/gabin', key: 'fixture-only' }),
  startLive: async () => undefined, stopLive: async () => undefined, hlsResource: async () => new Response('', { status: 404 }),
  subscribe: () => () => undefined, close: async () => undefined });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'nino-production-files-'));
  const dataDir = path.join(directory, 'private');
  const recordings = path.join(directory, 'recordings');
  await mkdir(recordings, { recursive: true });
  const mkv = path.join(recordings, 'original.mkv');
  const mp4 = path.join(recordings, 'original.mp4');
  await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le', mkv], { timeout: 15_000 });
  await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', mkv, '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', mp4], { timeout: 15_000 });
  const store = new Store(dataDir);
  const project: Project = { id: randomUUID(), title: '../Séance de test "intégrale"', description: 'Production fixture', owner: 'Équipe de test',
    format: 'podcast', participants: [{ id: 'alice', name: 'Alice', micInput: 'Micro', sceneName: 'Podcast' }], defaultScene: 'Podcast',
    status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.put('project', project);
  const take = (id: string, sequence: number, file: string, status: Take['status'] = 'completed'): Take => ({ id, projectId: project.id, sequence,
    title: `Prise ${sequence} / ../titre`, status, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    outputPath: file, recordingDirectory: recordings, durationMs: 1000 });
  const first = take(randomUUID(), 1, mkv);
  const second = take(randomUUID(), 2, mp4);
  const interrupted = take(randomUUID(), 3, path.join(recordings, 'not-verified.mkv'), 'interrupted');
  for (const value of [first, second, interrupted]) store.put('take', value);
  store.put('marker', { id: randomUUID(), takeId: first.id, label: '=Une réponse importante, "citation"', offsetMs: 300, createdAt: new Date().toISOString() });
  const assetId = randomUUID();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9i8AAAAASUVORK5CYII=', 'base64');
  const fileName = `${assetId}.png`;
  await mkdir(path.join(dataDir, 'library'), { recursive: true });
  const assetFile = path.join(dataDir, 'library', fileName);
  await writeFile(assetFile, png);
  const asset: MediaAsset = { id: assetId, title: 'Logo / ../source', originalName: '../../misleading.mov', kind: 'image', mimeType: 'image/png',
    sizeBytes: png.length, createdAt: new Date().toISOString(), archivedAt: new Date().toISOString(), durationMs: null, width: 1, height: 1 };
  store.put('mediaAsset', { id: assetId, asset, fileName, sha256: checksum(png) });
  store.put('projectMedia', { id: project.id, links: [{ assetId, role: 'logo', order: 0 }] });
  const app = await buildApp({ dataDir, media: fixtureMedia() });
  t.after(async () => { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const technician = (await app.inject({ method: 'POST', url: '/api/auth/local' })).json<AuthResult>();
  const headers = { authorization: `Bearer ${technician.token}` };
  const viewer = store.createDevice('iPad de test', 'ipad', 'viewer');
  const viewerHeaders = { authorization: `Bearer ${viewer.token}` };
  await app.inject({ method: 'PATCH', url: '/api/room', headers, payload: { obsPassword: 'PRIVATE-OBS-SECRET', liveDestination: { name: 'Live', server: 'rtmps://example.com/live', key: 'PRIVATE-LIVE-SECRET' } } });
  const ready = async (id: string, requested = true): Promise<FilePlaybackSession> => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const response = await app.inject({ method: 'POST', url: `/api/takes/${id}/playback-session`, headers: viewerHeaders,
        ...(requested ? { payload: { mimeType: 'video/mp4' } } : {}) });
      assert.ok([200, 202].includes(response.statusCode), response.body);
      const result = response.json<TakePlaybackStatus>();
      assert.notEqual(result.status, 'failed', result.error);
      if (result.status === 'ready') return result.session!;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Playback preparation timeout');
  };
  return { directory, dataDir, recordings, mkv, mp4, first, second, interrupted, project, asset, assetFile, png, store, app, technician, headers, viewer, viewerHeaders, ready };
}

/** Tiny ZIP64 reader for these test fixtures, with no runtime ZIP dependency. */
function unzip(buffer: Buffer): Map<string, Buffer> {
  const locator = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
  assert.ok(locator >= 0, 'ZIP64 locator present');
  const zip64 = Number(buffer.readBigUInt64LE(locator + 8));
  assert.equal(buffer.readUInt32LE(zip64), 0x06064b50);
  const count = Number(buffer.readBigUInt64LE(zip64 + 32));
  let cursor = Number(buffer.readBigUInt64LE(zip64 + 48));
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const compression = buffer.readUInt16LE(cursor + 10);
    let compressed = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24), offset = buffer.readUInt32LE(cursor + 42);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    let extra = cursor + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra < extraEnd) {
      const kind = buffer.readUInt16LE(extra), length = buffer.readUInt16LE(extra + 2);
      if (kind === 1) {
        let value = extra + 4;
        if (size === 0xffffffff) { size = Number(buffer.readBigUInt64LE(value)); value += 8; }
        if (compressed === 0xffffffff) { compressed = Number(buffer.readBigUInt64LE(value)); value += 8; }
        if (offset === 0xffffffff) offset = Number(buffer.readBigUInt64LE(value));
      }
      extra += 4 + length;
    }
    assert.ok(!name.startsWith('/') && !name.split('/').includes('..') && !name.includes('\\'));
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const compressedData = buffer.subarray(start, start + compressed);
    const data = compression === 0 ? compressedData : inflateRawSync(compressedData);
    assert.equal(data.length, size);
    files.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test('completed native and MKV recordings play inline with ranges, preserve originals, and remain revocable', { timeout: 30_000 }, async t => {
  const { app, store, first, second, interrupted, mkv, mp4, viewer, viewerHeaders, ready } = await fixture(t);
  const original = await readFile(mkv);
  assert.equal((await app.inject({ method: 'POST', url: `/api/takes/${first.id}/playback-session` })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: `/api/takes/${first.id}/playback-session`, headers: viewerHeaders, payload: { mimeType: 'image/png' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/takes/${interrupted.id}/playback-session`, headers: viewerHeaders })).statusCode, 404);
  const native = await ready(second.id);
  const nativeFile = await app.inject({ url: native.url });
  assert.equal(nativeFile.statusCode, 200, nativeFile.body);
  assert.equal(nativeFile.headers['content-type'], 'video/mp4');
  assert.match(String(nativeFile.headers['content-disposition']), /^inline;/);
  assert.deepEqual(nativeFile.rawPayload, await readFile(mp4), 'Native compatible MP4 is served unchanged');
  const converted = await ready(first.id);
  assert.match(converted.url, /^\/api\/playback-files\/[A-Za-z0-9_-]{43}$/);
  const full = await app.inject({ url: converted.url });
  assert.equal(full.statusCode, 200, full.body);
  assert.ok(full.rawPayload.subarray(0, 32).includes(Buffer.from('ftyp')), 'MKV is prepared as actual MP4');
  assert.equal(checksum(await readFile(mkv)), checksum(original), 'The original recording was never altered');
  const range = await app.inject({ url: converted.url, headers: { range: 'bytes=0-15' } });
  assert.equal(range.statusCode, 206);
  assert.equal(range.headers['content-range'], `bytes 0-15/${full.rawPayload.length}`);
  assert.deepEqual(range.rawPayload, full.rawPayload.subarray(0, 16));
  const suffix = await app.inject({ url: converted.url, headers: { range: 'bytes=-8' } });
  assert.equal(suffix.statusCode, 206);
  assert.deepEqual(suffix.rawPayload, full.rawPayload.subarray(-8));
  for (const invalid of ['bytes=-0', 'bytes=10-1', 'bytes=999999999-', 'bytes=0-1,5-6', 'bytes=9007199254740993-']) {
    assert.equal((await app.inject({ url: converted.url, headers: { range: invalid } })).statusCode, 416);
  }
  const head = await app.inject({ method: 'HEAD', url: converted.url });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), full.rawPayload.length);
  assert.equal((await app.inject({ url: converted.url, headers: { origin: 'https://evil.example' } })).statusCode, 403);
  store.revoke(viewer.device.id);
  assert.equal((await app.inject({ url: converted.url })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: `/api/takes/${first.id}/playback-session`, headers: viewerHeaders })).statusCode, 401);
});

test('production ZIP64 contains every completed original, linked archived media, safe metadata, markers and one-pass checksums', { timeout: 30_000 }, async t => {
  const { app, project, mkv, mp4, first, interrupted, png, viewerHeaders, directory, headers, viewer } = await fixture(t);
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export-ticket` })).statusCode, 401);
  const created = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export-ticket`, headers: viewerHeaders });
  assert.equal(created.statusCode, 200, created.body);
  const ticket = created.json<DownloadTicket>();
  assert.match(ticket.url, /^\/api\/production-exports\/[A-Za-z0-9_-]{43}$/);
  const head = await app.inject({ method: 'HEAD', url: ticket.url });
  assert.equal(head.statusCode, 200); assert.equal(head.body, '');
  assert.equal(head.headers['content-type'], 'application/zip');
  const reply = await app.inject({ url: ticket.url });
  assert.equal(reply.statusCode, 200, reply.body);
  assert.equal(reply.headers['cache-control'], 'no-store');
  const files = unzip(reply.rawPayload);
  for (const name of ['project.json', 'markers.json', 'markers.csv', 'manifest.json', 'README.txt']) assert.ok(files.has(name), name);
  const manifest = JSON.parse(files.get('manifest.json')!.toString());
  assert.equal(manifest.completedTakeCount, 2);
  assert.equal(manifest.complete, false, 'An interrupted take never makes the production look entirely validated');
  assert.equal(manifest.filesVerified, true);
  const firstFile = manifest.files.find((file: { id: string }) => file.id === first.id);
  assert.equal(checksum(files.get(firstFile.path)!), checksum(await readFile(mkv)));
  const originals = [...files].filter(([name]) => name.startsWith('takes/')).map(([, data]) => checksum(data));
  assert.deepEqual(new Set(originals), new Set([checksum(await readFile(mkv)), checksum(await readFile(mp4))]));
  const media = [...files].find(([name]) => name.startsWith('media/'))!;
  assert.ok(media[0].endsWith('.png'), 'Actual validated media format overrides a misleading upload filename');
  assert.deepEqual(media[1], png);
  for (const file of manifest.files) assert.equal(file.sha256, checksum(files.get(file.path)!));
  const omitted = manifest.takes.find((take: { id: string }) => take.id === interrupted.id);
  assert.equal(omitted.status, 'interrupted'); assert.equal(omitted.file, null); assert.ok(omitted.warning);
  const metadata = [...files].filter(([name]) => !name.startsWith('takes/') && !name.startsWith('media/')).map(([, data]) => data.toString()).join('\n');
  for (const secret of [directory, 'recordingDirectory', 'outputPath', 'PRIVATE-OBS-SECRET', 'PRIVATE-LIVE-SECRET', viewer.token]) assert.equal(metadata.includes(secret), false, secret);
  assert.match(files.get('markers.csv')!.toString(), /'=Une réponse/);
  assert.equal((await app.inject({ url: ticket.url, headers: { origin: 'https://evil.example' } })).statusCode, 403);
  await app.inject({ method: 'DELETE', url: `/api/devices/${viewer.device.id}`, headers });
  assert.equal((await app.inject({ url: ticket.url })).statusCode, 401);
});

test('complete exports reject missing files, malicious links, symlink escape and active production, including after ticket issuance', { timeout: 30_000 }, async t => {
  const { app, store, project, first, mkv, assetFile, asset, recordings, directory, viewerHeaders } = await fixture(t);
  const ticket = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export-ticket`, headers: viewerHeaders })).json<DownloadTicket>();
  await rename(assetFile, `${assetFile}.moved`);
  const missing = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export-ticket`, headers: viewerHeaders });
  assert.equal(missing.statusCode, 409); assert.equal(missing.json().code, 'MISSING_PRODUCTION_FILE');
  assert.equal((await app.inject({ method: 'HEAD', url: ticket.url })).statusCode, 409);
  await rename(`${assetFile}.moved`, assetFile);
  store.put('projectMedia', { id: project.id, links: [{ assetId: '../../private/studio.sqlite', role: 'other', order: 0 }] });
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export-ticket`, headers: viewerHeaders })).statusCode, 409);
  store.put('projectMedia', { id: project.id, links: [{ assetId: asset.id, role: 'logo', order: 0 }] });
  const outside = path.join(directory, 'outside.mkv');
  await writeFile(outside, 'unrelated private file');
  const escaped = path.join(recordings, 'escaped.mkv');
  await symlink(outside, escaped);
  store.put('take', { ...first, outputPath: escaped });
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export-ticket`, headers: viewerHeaders })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/takes/${first.id}/playback-session`, headers: viewerHeaders })).statusCode, 403);
  store.put('take', { ...first, outputPath: mkv });
  store.setSetting('pendingTake', { ...first, status: 'recording' });
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export-ticket`, headers: viewerHeaders })).statusCode, 409);
  assert.equal((await app.inject({ url: ticket.url })).statusCode, 409);
  store.setSetting('pendingTake', null);
  await rename(mkv, `${mkv}.moved`);
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export-ticket`, headers: viewerHeaders })).statusCode, 409);
});

test('playback fails honestly for broken sources and rejects cache directory replacement and changed originals', { timeout: 30_000 }, async t => {
  const { app, store, dataDir, recordings, first, mkv, viewerHeaders, ready } = await fixture(t);
  const session = await ready(first.id);
  const directory = path.join(dataDir, 'playback');
  const held = `${directory}.held`;
  await rename(directory, held);
  await mkdir(path.join(recordings, 'foreign-cache'));
  await symlink(path.join(recordings, 'foreign-cache'), directory);
  assert.equal((await app.inject({ url: session.url })).statusCode, 403, 'An initialized cache is revalidated on every use');
  await rm(directory); await rename(held, directory);
  await writeFile(mkv, 'broken completed recording fixture');
  assert.equal((await app.inject({ url: session.url })).statusCode, 409);
  let result: TakePlaybackStatus = { status: 'preparing' };
  for (let attempt = 0; attempt < 100 && result.status === 'preparing'; attempt++) {
    result = (await app.inject({ method: 'POST', url: `/api/takes/${first.id}/playback-session`, headers: viewerHeaders, payload: { mimeType: 'video/mp4' } })).json<TakePlaybackStatus>();
    if (result.status === 'preparing') await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(result.status, 'failed'); assert.ok(result.error); assert.equal(result.session, undefined);
  for (let attempt = 0; attempt < 3; attempt++) {
    const failed = (await app.inject({ method: 'POST', url: `/api/takes/${first.id}/playback-session`, headers: viewerHeaders, payload: { mimeType: 'video/mp4' } })).json<TakePlaybackStatus>();
    assert.deepEqual(failed, result, 'Polling a failed source does not restart encoding in a loop');
  }
});

test('lost playback cache is regenerated, expired playback and export tickets stop working', { timeout: 30_000 }, async t => {
  const { app, dataDir, first, project, viewerHeaders, ready } = await fixture(t);
  const initial = await ready(first.id);
  const directory = path.join(dataDir, 'playback');
  const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.mp4$/.test(name));
  assert.equal(files.length, 1);
  await rm(path.join(directory, files[0]!));
  const preparing = await app.inject({ method: 'POST', url: `/api/takes/${first.id}/playback-session`, headers: viewerHeaders, payload: { mimeType: 'video/mp4' } });
  assert.equal(preparing.json<TakePlaybackStatus>().status, 'preparing');
  const regenerated = await ready(first.id);
  assert.equal((await app.inject({ url: regenerated.url })).statusCode, 200);
  assert.equal((await app.inject({ url: initial.url })).statusCode, 404, 'An old session never serves a replacement without validating its identity');
  const ticket = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export-ticket`, headers: viewerHeaders })).json<DownloadTicket>();
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 3 * 3600_000);
  assert.equal((await app.inject({ url: regenerated.url })).statusCode, 401);
  assert.equal((await app.inject({ method: 'HEAD', url: ticket.url })).statusCode, 401);
  t.mock.restoreAll();
});

test('WebM can remain native or be prepared for Safari as MP4', { timeout: 30_000 }, async t => {
  const { app, store, recordings, first, mkv, viewerHeaders, ready } = await fixture(t);
  const webm = path.join(recordings, 'webm.webm');
  await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', mkv, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
    '-b:v', '300k', '-c:a', 'libopus', webm], { timeout: 15_000 });
  const take = { ...first, id: randomUUID(), outputPath: webm, sequence: 4 };
  store.put('take', take);
  const native = await ready(take.id, false);
  assert.equal(native.mimeType, 'video/webm');
  assert.deepEqual((await app.inject({ url: native.url })).rawPayload, await readFile(webm));
  const converted = await ready(take.id);
  assert.equal(converted.mimeType, 'video/mp4');
  const video = await app.inject({ url: converted.url });
  assert.equal(video.statusCode, 200); assert.ok(video.rawPayload.subarray(0, 32).includes(Buffer.from('ftyp')));
  assert.equal((await app.inject({ method: 'POST', url: `/api/takes/${take.id}/playback-session`, headers: viewerHeaders, payload: { mimeType: 'video/mp4' } })).json<TakePlaybackStatus>().status, 'ready');
  assert.ok((await stat(webm)).size > 0);
});

test('conversion is stopped against the remaining cache budget while existing playback files are protected', { timeout: 30_000 }, async t => {
  if (process.platform === 'win32') { t.skip('Executable test fixture uses a Unix shebang'); return; }
  const { directory, dataDir, first, mkv } = await fixture(t);
  await mkdir(path.join(dataDir, 'playback'), { recursive: true });
  const cache = await realpath(path.join(dataDir, 'playback'));
  const existing = path.join(cache, `${'a'.repeat(64)}.mp4`);
  await writeFile(existing, Buffer.alloc(800 * 1024));
  const encoder = path.join(directory, 'oversized-encoder.mjs');
  await writeFile(encoder, `#!/usr/bin/env node\nimport { writeFile } from 'node:fs/promises';\nawait writeFile(process.argv.at(-1), Buffer.alloc(300 * 1024));\nsetTimeout(() => process.exit(0), 30000);\n`);
  await chmod(encoder, 0o755);
  const ffprobe = process.env.GABIN_FFPROBE_PATH ?? (path.isAbsolute(ffmpeg) ? path.join(path.dirname(ffmpeg), 'ffprobe') : 'ffprobe');
  const playback = new TakePlayback(dataDir, { ffmpegPath: encoder, ffprobePath: ffprobe, cacheMaxBytes: 1024 * 1024, conversionTimeoutMs: 10_000 });
  t.after(() => playback.close());
  playback.pin(existing);
  const file = await realpath(mkv);
  const job = playback.request({ take: first, file, fileStat: await stat(file) }, true);
  const started = Date.now();
  while (job.status === 'preparing' && Date.now() - started < 4000) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(job.status, 'failed');
  assert.match(job.error!, /cache/);
  assert.ok(Date.now() - started < 4000, 'The growth guard stops the encoder before its process timeout');
  assert.equal((await stat(existing)).size, 800 * 1024, 'A protected playback file is never evicted');
  assert.equal((await readdir(cache)).filter(name => name.endsWith('.partial.mp4')).length, 0);
});

test('server shutdown cancels held native video and streaming ZIP connections before request drainage', { timeout: 30_000 }, async t => {
  const { app, mp4, second, project, viewerHeaders, ready } = await fixture(t);
  await truncate(mp4, 64 * 1024 * 1024); // A sparse tail keeps the fixture cheap while holding network backpressure.
  const session = await ready(second.id);
  const ticket = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export-ticket`, headers: viewerHeaders })).json<DownloadTicket>();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const connections: { request: ClientRequest; response: IncomingMessage }[] = [];
  t.after(() => { for (const connection of connections) { connection.response.destroy(); connection.request.destroy(); } });
  for (const route of [session.url, ticket.url]) await new Promise<void>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${address.port}${route}`, response => {
      response.on('error', () => undefined); response.pause();
      assert.equal(response.statusCode, 200);
      connections.push({ request, response }); resolve();
    });
    request.once('error', reject);
    request.on('error', () => undefined);
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([app.close(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Held transfer prevented shutdown')), 2000); })]);
  } finally { clearTimeout(timer); }
});
