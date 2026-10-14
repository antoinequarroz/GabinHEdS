import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import OBSWebSocket from 'obs-websocket-js/json';
import type { AuthResult, FilePlaybackSession, MediaAsset, PairingCode, Project, StudioState } from '@gabin/shared';
import { buildApp } from '../src/app.js';
import { libraryFile } from '../src/library.js';
import { Store } from '../src/store.js';
import { emptyMediaState, type MediaGateway } from '../src/media.js';
import { startFakeObs } from '../../../tests/fake-obs.js';

const dormantMedia: MediaGateway = { getState: emptyMediaState, refresh: async () => emptyMediaState(),
  ingestSettings: () => ({ server: 'rtmp://127.0.0.1:9/gabin', key: 'test' }), startLive: async () => { throw new Error('No live in library tests'); },
  stopLive: async () => undefined, hlsResource: async () => new Response('', { status: 404 }), subscribe: () => () => undefined, close: async () => undefined };

async function setup(t: TestContext, connect = false, ownerId?: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'nino-library-test-'));
  const dataDir = path.join(directory, 'data');
  if (ownerId) { const store = new Store(dataDir); store.setSetting('libraryOwnerId', ownerId); store.close(); }
  const fixture = await startFakeObs({ meters: false });
  const app = await buildApp({ dataDir, media: dormantMedia });
  t.after(async () => { await app.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const auth = (await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost' } })).json<AuthResult>();
  const headers = { authorization: `Bearer ${auth.token}` };
  if (connect) {
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/room', headers, payload: { obsUrl: fixture.url, recordingRoot: path.join(directory, 'recordings') } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/obs/connect', headers })).statusCode, 200);
  }
  const ffmpeg = process.env.GABIN_FFMPEG_PATH ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
  const image = path.join(directory, 'image.png'); const audio = path.join(directory, 'music.wav'); const video = path.join(directory, 'clip.mp4');
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=1', '-frames:v', '1', '-threads', '1', image], { timeout: 5000 });
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', audio], { timeout: 5000 });
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart', video], { timeout: 5000 });
  const imageBytes = await readFile(image); const audioBytes = await readFile(audio); const videoBytes = await readFile(video);
  const boundary = 'nino-library-test-boundary';
  const multipart = (body: Buffer, name: string, mime = 'application/octet-stream', title = 'Média de test') => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`), body,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n--${boundary}--\r\n`),
  ]);
  const upload = async (body: Buffer, name: string, mime?: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/library', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipart(body, name, mime) });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<MediaAsset>();
  };
  const project = (await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { title: 'Production avec médias', format: 'podcast',
    participants: [{ id: 'person', name: 'Camille', micInput: 'Micro 1', sceneName: 'Podcast' }] } })).json<Project>();
  return { directory, dataDir, app, fixture, auth, headers, imageBytes, audioBytes, videoBytes, multipart, boundary, upload, project };
}

test('library imports signatures and actual metadata, preserves archived project files, and serves revocable ranged tickets', async t => {
  const { app, headers, dataDir, upload, imageBytes, audioBytes, videoBytes, project, multipart, boundary } = await setup(t);
  assert.equal((await app.inject({ url: '/api/library' })).statusCode, 401);
  const image = await upload(imageBytes, '../../logo.svg', 'image/svg+xml');
  assert.equal(image.kind, 'image'); assert.equal(image.mimeType, 'image/png'); assert.equal(image.width, 320); assert.equal(image.height, 180);
  assert.equal(image.originalName, 'logo.svg'); assert.equal(image.title, 'Média de test');
  const audio = await upload(audioBytes, 'music.wav'); assert.equal(audio.kind, 'audio'); assert.equal(audio.durationMs, 1000);
  const video = await upload(videoBytes, 'clip.mp4'); assert.equal(video.kind, 'video'); assert.equal(video.durationMs, 1000);
  assert.equal((await app.inject({ url: `/api/library/${video.id}/thumbnail` })).statusCode, 401);
  const poster = await app.inject({ url: `/api/library/${video.id}/thumbnail`, headers });
  assert.equal(poster.statusCode, 200, poster.body); assert.equal(poster.headers['content-type'], 'image/jpeg'); assert.equal(poster.rawPayload.readUInt16BE(0), 0xffd8);
  for (const body of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('#EXTM3U\nhttps://example.invalid/movie.mp4')]) {
    const response = await app.inject({ method: 'POST', url: '/api/library', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipart(body, 'disguised.png', 'image/png') });
    assert.equal(response.statusCode, 415, response.body);
  }
  assert.equal((await readdir(path.join(dataDir, 'library'))).some(name => name.startsWith('.upload-')), false);
  const links = [{ assetId: image.id, role: 'logo', order: 0 }];
  assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/media`, headers, payload: { links } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/media`, headers, payload: { links: [...links, ...links] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/library/${image.id}`, headers, payload: { archived: true } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/media`, headers, payload: { links } })).statusCode, 200, 'Existing archived links are retained');
  const other = (await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { title: 'Second project', format: 'podcast' } })).json<Project>();
  assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${other.id}/media`, headers, payload: { links } })).statusCode, 400, 'Archived asset cannot be newly linked');
  const state = (await app.inject({ url: '/api/state', headers })).json<StudioState>();
  assert.equal(state.library?.length, 3); assert.deepEqual(state.projectMedia?.[project.id], links);
  assert(!JSON.stringify(state.library).includes(dataDir), 'Public assets contain no private storage paths');
  const pairing = (await app.inject({ method: 'POST', url: '/api/pairing', headers, payload: { role: 'viewer', kind: 'ipad' } })).json<PairingCode>();
  const viewer = (await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: pairing.code, name: 'Viewer', kind: 'ipad' } })).json<AuthResult>();
  const viewerHeaders = { authorization: `Bearer ${viewer.token}` };
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/library/${audio.id}`, headers: viewerHeaders, payload: { title: 'Unauthorized' } })).statusCode, 403);
  const session = (await app.inject({ method: 'POST', url: `/api/library/${image.id}/file-ticket`, headers: viewerHeaders })).json<FilePlaybackSession>();
  assert.match(session.url, /^\/api\/library-files\/[A-Za-z0-9_-]{43}$/);
  const ranged = await app.inject({ url: session.url, headers: { range: 'bytes=0-7' } });
  assert.equal(ranged.statusCode, 206); assert.deepEqual(ranged.rawPayload, imageBytes.subarray(0, 8));
  assert.equal((await app.inject({ url: session.url, headers: { range: 'bytes=999999-' } })).statusCode, 416);
  assert.equal((await app.inject({ url: '/api/library-files/' + 'A'.repeat(43) })).statusCode, 401);
  await app.inject({ method: 'DELETE', url: `/api/devices/${viewer.device.id}`, headers });
  assert.equal((await app.inject({ url: session.url })).statusCode, 401);
  const store = new Store(dataDir); t.after(() => store.close());
  const resolved = await libraryFile(store, image.id); assert.equal(resolved.asset.archivedAt !== null, true);
  const outside = path.join(dataDir, 'outside.png'); await writeFile(outside, imageBytes);
  await rm(resolved.file); await symlink(outside, resolved.file);
  await assert.rejects(libraryFile(store, image.id), { statusCode: 404 });
});

test('revocation during a streamed upload rejects the commit and removes temporary files', async t => {
  const { app, headers, imageBytes, boundary, dataDir } = await setup(t);
  const pairing = (await app.inject({ method: 'POST', url: '/api/pairing', headers, payload: { role: 'operator', kind: 'ipad' } })).json<PairingCode>();
  const operator = (await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: pairing.code, name: 'Uploader', kind: 'ipad' } })).json<AuthResult>();
  let started!: () => void; const observed = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const body = Readable.from((async function* () {
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`);
    yield imageBytes; started(); await gate;
    yield Buffer.from(`\r\n--${boundary}--\r\n`);
  })());
  const pending = app.inject({ method: 'POST', url: '/api/library', headers: { authorization: `Bearer ${operator.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  await observed;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/devices/${operator.device.id}`, headers })).statusCode, 204);
  finish(); const response = await pending;
  assert.equal(response.statusCode, 401, response.body);
  assert.deepEqual((await app.inject({ url: '/api/library', headers })).json(), []);
  assert.deepEqual(await readdir(path.join(dataDir, 'library')), []);
});

test('OBS media controls confirm real protocol states, keep recording independent, and respect manual scene changes', async t => {
  const { app, headers, fixture, upload, imageBytes, audioBytes, project } = await setup(t, true);
  const image = await upload(imageBytes, 'logo.png'); const audio = await upload(audioBytes, 'music.wav');
  const document = await upload(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'), 'presentation.pdf');
  const control = (payload: object) => app.inject({ method: 'POST', url: '/api/control', headers, payload });
  assert.equal((await control({ action: 'media.play', assetId: image.id, projectId: project.id, mode: 'overlay' })).statusCode, 409, 'Project playback requires explicit association');
  await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/media`, headers, payload: { links: [{ assetId: image.id, role: 'logo', order: 0 }, { assetId: audio.id, role: 'music', order: 1 }, { assetId: document.id, role: 'presentation', order: 2 }] } });
  assert.equal((await control({ action: 'media.play', assetId: document.id, projectId: project.id })).statusCode, 400, 'Documents are stored and downloaded, not presented as ready OBS sources');
  const imageResult = await control({ action: 'media.play', assetId: image.id, projectId: project.id, mode: 'fullscreen' });
  assert.equal(imageResult.statusCode, 200, imageResult.body); assert.equal(imageResult.json<StudioState>().mediaPlayback?.status, 'shown');
  assert.equal(imageResult.json<StudioState>().obs.currentScene, 'Nino · Médias');
  assert.equal((await control({ action: 'media.pause' })).statusCode, 409, 'Images do not invent pause support');
  assert.equal((await control({ action: 'scene.set', sceneName: 'Caméra 1' })).statusCode, 200);
  const hidden = (await app.inject({ url: '/api/state', headers })).json<StudioState>();
  assert.equal(hidden.mediaPlayback?.status, 'unknown', 'Changing the programme does not claim the old image is still shown');
  const stoppedImage = await control({ action: 'media.stop' }); assert.equal(stoppedImage.statusCode, 200, stoppedImage.body);
  assert.equal(stoppedImage.json<StudioState>().obs.currentScene, 'Caméra 1', 'Stopping media preserves an operator-selected scene');
  assert.equal((await control({ action: 'record.start', projectId: project.id })).statusCode, 200);
  const play = await control({ action: 'media.play', assetId: audio.id, projectId: project.id, mode: 'audio' });
  assert.equal(play.statusCode, 200, play.body); assert.equal(play.json<StudioState>().mediaPlayback?.status, 'playing');
  assert.equal((await control({ action: 'media.pause' })).json<StudioState>().mediaPlayback?.status, 'paused');
  assert.equal((await control({ action: 'media.resume' })).json<StudioState>().mediaPlayback?.status, 'playing');
  const stop = await control({ action: 'media.stop' }); assert.equal(stop.statusCode, 200, stop.body);
  assert.equal(stop.json<StudioState>().mediaPlayback?.status, 'stopped'); assert.equal(stop.json<StudioState>().obs.recording, true);
  assert(fixture.requests.some(request => request.requestType === 'GetMediaInputStatus'));
  assert(!fixture.requests.some(request => request.requestType === 'StopRecord'), 'Media transport never controls recording');
  const other = (await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { title: 'Other', format: 'podcast' } })).json<Project>();
  await app.inject({ method: 'PUT', url: `/api/projects/${other.id}/media`, headers, payload: { links: [{ assetId: audio.id, role: 'music', order: 0 }] } });
  assert.equal((await control({ action: 'media.play', assetId: audio.id, projectId: other.id, mode: 'audio' })).statusCode, 409);
  await app.inject({ method: 'POST', url: '/api/obs/disconnect', headers });
  assert.equal((await control({ action: 'media.resume' })).statusCode, 409, 'Disconnected OBS cannot claim success');
});

test('an operator-modified Nino source is never disabled or overwritten by a later media command', async t => {
  const { app, headers, fixture, upload, imageBytes, directory } = await setup(t, true);
  const first = await upload(imageBytes, 'first.png'); const second = await upload(imageBytes, 'second.png');
  const control = (payload: object) => app.inject({ method: 'POST', url: '/api/control', headers, payload });
  assert.equal((await control({ action: 'media.play', assetId: first.id, mode: 'overlay' })).statusCode, 200);
  assert.equal((await control({ action: 'media.stop' })).statusCode, 200);
  const inputName = String(fixture.requests.filter(request => request.requestType === 'CreateInput').at(-1)!.requestData.inputName);
  const client = new OBSWebSocket(); await client.connect(fixture.url); t.after(() => client.disconnect());
  const userFile = path.join(directory, 'user-selected-file.png');
  await client.call('SetInputSettings', { inputName, inputSettings: { file: userFile }, overlay: true });
  const baseline = fixture.requests.length;
  const result = await control({ action: 'media.play', assetId: second.id, mode: 'overlay' });
  assert.equal(result.statusCode, 409, result.body);
  assert(!result.body.includes(directory), 'Private paths do not leak in API errors');
  assert.equal(fixture.requests.slice(baseline).some(request => request.requestType === 'SetSceneItemEnabled'), false);
  assert.equal((await client.call('GetInputSettings', { inputName })).inputSettings.file, userFile);
});

test('replaying an ended fullscreen clip retains its original return plan and refreshes the command snapshot', async t => {
  const { app, headers, fixture, upload, videoBytes } = await setup(t, true);
  const video = await upload(videoBytes, 'clip.mp4');
  const control = (payload: object) => app.inject({ method: 'POST', url: '/api/control', headers, payload });
  assert.equal((await control({ action: 'scene.set', sceneName: 'Caméra 1' })).statusCode, 200);
  const first = await control({ action: 'media.play', assetId: video.id, mode: 'fullscreen' });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json<StudioState>().mediaPlayback?.status, 'playing');
  assert.equal(first.json<StudioState>().obs.currentScene, 'Nino · Médias', 'The command response already contains the confirmed programme scene');
  fixture.finishMedia();
  const ended = await app.inject({ method: 'POST', url: '/api/obs/connect', headers });
  assert.equal(ended.json<StudioState>().mediaPlayback?.status, 'stopped');
  assert.equal(ended.json<StudioState>().obs.currentScene, 'Nino · Médias');
  const replay = await control({ action: 'media.play', assetId: video.id, mode: 'fullscreen' });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json<StudioState>().mediaPlayback?.status, 'playing');
  assert.equal(replay.json<StudioState>().obs.currentScene, 'Nino · Médias');
  const stopped = await control({ action: 'media.stop' });
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.equal(stopped.json<StudioState>().mediaPlayback?.status, 'stopped');
  assert.equal(stopped.json<StudioState>().obs.currentScene, 'Caméra 1', 'Replay must not replace the return destination with Nino · Médias');
  assert.equal((await control({ action: 'media.play', assetId: video.id, mode: 'fullscreen' })).statusCode, 200);
  fixture.finishMedia();
  assert.equal((await control({ action: 'scene.set', sceneName: 'Plan large' })).statusCode, 200);
  assert.equal((await control({ action: 'media.play', assetId: video.id, mode: 'fullscreen' })).statusCode, 200);
  assert.equal((await control({ action: 'media.stop' })).json<StudioState>().obs.currentScene, 'Plan large', 'A manually changed plan remains the next clip’s return destination');
});

test('OBS source and scene ownership reject collisions and modified private paths without replacing user sources', async t => {
  const ownerId = '01234567-0123-4123-8123-012345678901';
  const { app, headers, fixture, upload, imageBytes, dataDir } = await setup(t, true, ownerId);
  const image = await upload(imageBytes, 'logo.png');
  const client = new OBSWebSocket(); await client.connect(fixture.url); t.after(() => client.disconnect());
  const control = (payload: object) => app.inject({ method: 'POST', url: '/api/control', headers, payload });
  await client.call('CreateScene', { sceneName: 'Nino · Médias' });
  const collision = await control({ action: 'media.play', assetId: image.id, mode: 'fullscreen' });
  assert.equal(collision.statusCode, 409, collision.body); assert.match(collision.json().error, /identifiable/);
  const inputName = `Nino · ${ownerId.slice(0, 8)} · ${image.id}`;
  await client.call('CreateInput', { sceneName: 'Table ronde', inputName, inputKind: 'image_source', inputSettings: { file: path.join(dataDir, 'library', `${image.id}.png`), nino_owner: 'another-owner', nino_asset: image.id }, sceneItemEnabled: true });
  const baseline = fixture.requests.length;
  const refusal = await control({ action: 'media.play', assetId: image.id, mode: 'overlay' }); assert.equal(refusal.statusCode, 409, refusal.body);
  assert.equal(fixture.requests.slice(baseline).some(request => ['SetInputSettings', 'SetSceneItemEnabled'].includes(request.requestType)), false);
  const foreign = await client.call('GetInputSettings', { inputName }); assert.equal(foreign.inputSettings.nino_owner, 'another-owner');
});

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Shutdown did not finish within its bound')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

test('shutdown aborts a held HTTP multipart upload before drain and removes partial files without committing an asset', { timeout: 15_000 }, async t => {
  const { app, dataDir, headers, boundary, imageBytes } = await setup(t);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  let peerClosed!: () => void;
  const closed = new Promise<void>(resolve => { peerClosed = resolve; });
  const request = httpRequest(`${url}/api/library`, { method: 'POST', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` } }, response => response.resume());
  request.on('error', peerClosed); request.on('close', peerClosed);
  t.after(() => request.destroy());
  request.write(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="held.png"\r\nContent-Type: image/png\r\n\r\n`));
  request.write(imageBytes);
  const directory = path.join(dataDir, 'library');
  let partial = false;
  for (let attempt = 0; attempt < 100 && !partial; attempt++) {
    partial = (await readdir(directory).catch(() => [])).some(name => name.startsWith('.upload-'));
    if (!partial) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(partial, true, 'The held upload reached the actual private-file pipeline');
  const closing = app.close();
  try { await within(closing, 2000); }
  finally { request.destroy(); }
  await within(closed, 1000);
  assert.deepEqual(await readdir(directory), [], 'Shutdown awaited the upload finally cleanup');
  const store = new Store(dataDir);
  try { assert.deepEqual(store.library(), [], 'Shutdown never committed the cancelled upload'); }
  finally { store.close(); }
});

test('shutdown aborts a held library HTTP file response before waiting for request drain', { timeout: 15_000 }, async t => {
  const { app, headers, upload } = await setup(t);
  const document = await upload(Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'), Buffer.alloc(16 * 1024 * 1024)]), 'large-test-document.pdf');
  const session = (await app.inject({ method: 'POST', url: `/api/library/${document.id}/file-ticket`, headers })).json<FilePlaybackSession>();
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  let responseReady!: (response: IncomingMessage) => void;
  const ready = new Promise<IncomingMessage>(resolve => { responseReady = resolve; });
  const request = httpRequest(`${url}${session.url}`, response => { response.on('error', () => undefined); response.pause(); responseReady(response); });
  request.on('error', () => undefined); request.end(); t.after(() => request.destroy());
  const response = await within(ready, 2000);
  assert.equal(response.statusCode, 200); assert.equal(response.readableEnded, false);
  const closing = app.close();
  try { await within(closing, 2000); }
  finally { request.destroy(); response.destroy(); }
});
