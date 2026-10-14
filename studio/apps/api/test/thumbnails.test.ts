import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuthResult, PairingCode, SceneThumbnail, Take } from '@gabin/shared';
import { buildApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { startFakeObs } from '../../../tests/fake-obs.js';

test('scene thumbnails use real OBS protocol, cache/coalesce work, reject arbitrary sources and honor revocation', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gabin-thumbnails-'));
  const fixture = await startFakeObs({ meters: false });
  const app = await buildApp({ dataDir: directory });
  t.after(async () => { await app.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const unauthenticated = await app.inject({ url: '/api/obs/scenes/thumbnail?name=Podcast' });
  assert.equal(unauthenticated.statusCode, 401);
  const auth = (await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost' } })).json<AuthResult>();
  const headers = { authorization: `Bearer ${auth.token}` };
  await app.inject({ method: 'PATCH', url: '/api/room', headers, payload: { obsUrl: fixture.url } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/obs/connect', headers })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/obs/scenes/thumbnail?name=Micro%201', headers })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/obs/scenes/thumbnail?name=http%3A%2F%2Fevil.example', headers })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/obs/scenes/thumbnail', headers })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/obs/scenes/thumbnail?name=Podcast', headers: { ...headers, origin: 'https://evil.example' } })).statusCode, 403);
  const names = ['Podcast', 'Table ronde', 'PowerPoint', 'Plan large', 'Caméra 1'];
  const replies = await Promise.all([...names, 'Podcast', 'Podcast'].map(name => app.inject({ url: `/api/obs/scenes/thumbnail?name=${encodeURIComponent(name)}`, headers })));
  for (const reply of replies) {
    assert.equal(reply.statusCode, 200);
    const image = reply.json<SceneThumbnail>();
    assert.equal(image.available, true);
    assert.match(image.imageData!, /^data:image\/jpeg;base64,/);
    assert.equal(Number.isFinite(Date.parse(image.capturedAt!)), true);
    assert.equal(reply.headers['cache-control'], 'no-store');
  }
  const screenshotRequests = fixture.requests.filter(request => request.requestType === 'GetSourceScreenshot');
  assert.equal(screenshotRequests.length, names.length, 'Concurrent mounted scene tiles all receive images; duplicate calls share one capture');
  for (const request of screenshotRequests) assert.deepEqual(request.requestData, { sourceName: request.requestData.sourceName,
    imageFormat: 'jpeg', imageWidth: 320, imageHeight: 180, imageCompressionQuality: 65 });
  await app.inject({ url: '/api/obs/scenes/thumbnail?name=Podcast', headers });
  assert.equal(fixture.requests.filter(request => request.requestType === 'GetSourceScreenshot').length, names.length);
  const pairing = (await app.inject({ method: 'POST', url: '/api/pairing', headers, payload: { role: 'viewer', kind: 'ipad' } })).json<PairingCode>();
  const viewer = (await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: pairing.code, name: 'iPad', kind: 'ipad' } })).json<AuthResult>();
  const viewerHeaders = { authorization: `Bearer ${viewer.token}` };
  assert.equal((await app.inject({ url: '/api/obs/scenes/thumbnail?name=Podcast', headers: viewerHeaders })).json<SceneThumbnail>().available, true);
  await app.inject({ method: 'DELETE', url: `/api/devices/${viewer.device.id}`, headers });
  assert.equal((await app.inject({ url: '/api/obs/scenes/thumbnail?name=Podcast', headers: viewerHeaders })).statusCode, 401);
  await app.inject({ method: 'POST', url: '/api/obs/disconnect', headers });
  assert.deepEqual((await app.inject({ url: '/api/obs/scenes/thumbnail?name=Podcast', headers })).json<SceneThumbnail>(),
    { sceneName: 'Podcast', imageData: null, capturedAt: null, available: false });
});

test('completed-take posters decode authorized real video, reject symlink escape, incomplete takes and revoked devices', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gabin-posters-'));
  const recordingDirectory = path.join(directory, 'recordings', 'take');
  await mkdir(recordingDirectory, { recursive: true });
  const outputPath = path.join(recordingDirectory, 'test.mp4');
  const ffmpeg = process.env.GABIN_FFMPEG_PATH ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=1',
    '-frames:v', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath], { timeout: 5000 });
  const second = path.join(recordingDirectory, 'second.mp4');
  const third = path.join(recordingDirectory, 'third.mp4');
  await Promise.all([copyFile(outputPath, second), copyFile(outputPath, third)]);
  const external = path.join(directory, 'external.mp4');
  await writeFile(external, 'private file outside the take');
  const escaped = path.join(recordingDirectory, 'escaped.mp4');
  await symlink(external, escaped);
  const disguised = path.join(recordingDirectory, 'playlist.mp4');
  await writeFile(disguised, `#EXTM3U\n${external}\n`);
  const store = new Store(path.join(directory, 'data'));
  const take: Take = { id: 'complete', projectId: 'project', sequence: 1, title: 'Fixture take', status: 'completed',
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), recordingDirectory, outputPath, durationMs: 1000 };
  for (const [id, status, file] of [['complete', 'completed', outputPath], ['second', 'completed', second], ['third', 'completed', third], ['escaped', 'completed', escaped],
    ['interrupted', 'interrupted', outputPath], ['missing', 'completed', path.join(recordingDirectory, 'missing.mp4')],
    ['disguised', 'completed', disguised]] as const) store.put('take', { ...take, id, status, outputPath: file });
  store.close();
  const app = await buildApp({ dataDir: path.join(directory, 'data') });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await app.inject({ url: '/api/takes/complete/thumbnail' })).statusCode, 401);
  const auth = (await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost' } })).json<AuthResult>();
  const headers = { authorization: `Bearer ${auth.token}` };
  const replies = await Promise.all(['complete', 'second', 'third', 'complete'].map(id => app.inject({ url: `/api/takes/${id}/thumbnail`, headers })));
  for (const reply of replies) {
    assert.equal(reply.statusCode, 200);
    assert.equal(reply.headers['content-type'], 'image/jpeg');
    assert.equal(reply.rawPayload.readUInt16BE(0), 0xffd8);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.ok(reply.rawPayload.length < 1024 * 1024);
  }
  assert.equal((await app.inject({ url: '/api/takes/escaped/thumbnail', headers })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/takes/interrupted/thumbnail', headers })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/takes/missing/thumbnail', headers })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/takes/disguised/thumbnail', headers })).statusCode, 503);
  assert.equal((await app.inject({ url: '/api/takes/complete/file', headers })).statusCode, 200, 'Existing download still reads the same authorized video');
  const deck = (await app.inject({ method: 'POST', url: '/api/devices', headers, payload: { kind: 'streamdeck', role: 'viewer', name: 'Deck' } })).json<AuthResult>();
  const deckHeaders = { authorization: `Bearer ${deck.token}` };
  assert.equal((await app.inject({ url: '/api/takes/complete/thumbnail', headers: deckHeaders })).statusCode, 200);
  await app.inject({ method: 'DELETE', url: `/api/devices/${deck.device.id}`, headers });
  assert.equal((await app.inject({ url: '/api/takes/complete/thumbnail', headers: deckHeaders })).statusCode, 401);
});
