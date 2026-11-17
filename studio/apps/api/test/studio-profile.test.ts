import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RoomConfig, StudioProfile, StudioState } from '@nino/shared';
import { buildApp } from '../src/app.js';

async function studio(t: test.TestContext, name: string) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `nino-profile-${name}-`));
  const app = await buildApp({ dataDir });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const auth = (await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost' } })).json();
  return { app, dataDir, headers: { authorization: `Bearer ${auth.token}` } };
}

test('a studio exports its configuration without any secret and another studio imports it', async (t) => {
  const first = await studio(t, 'a');
  const recordingRoot = path.join(first.dataDir, 'videos');
  const configured = await first.app.inject({ method: 'PATCH', url: '/api/room', headers: first.headers, payload: {
    name: 'Studio Sion', captureSoftware: 'maya', obsUrl: 'ws://127.0.0.1:4460', obsPassword: 'jeton-secret', recordingRoot,
    defaultScenes: { podcast: 'Plateau', roundtable: 'Table', slides: 'Écran' },
    liveDestination: { name: 'YouTube', server: 'rtmps://a.rtmp.youtube.com/live2', key: 'cle-secrete' } } });
  assert.equal(configured.statusCode, 200, configured.body);

  const exported = await first.app.inject({ method: 'GET', url: '/api/room/profile', headers: first.headers });
  assert.equal(exported.statusCode, 200);
  assert.match(String(exported.headers['content-disposition']), /nino-studio-studio-sion\.json/);
  const profile = exported.json<StudioProfile>();
  assert.deepEqual(profile.room, { name: 'Studio Sion', captureSoftware: 'maya', captureUrl: 'ws://127.0.0.1:4460', recordingRoot,
    defaultScenes: { podcast: 'Plateau', roundtable: 'Table', slides: 'Écran' },
    liveDestination: { name: 'YouTube', server: 'rtmps://a.rtmp.youtube.com/live2' } });
  assert.doesNotMatch(exported.body, /jeton-secret|cle-secrete|studioId/, 'No password, live key or studio identity leaves the studio');

  const second = await studio(t, 'b');
  const before = (await second.app.inject({ method: 'GET', url: '/api/state', headers: second.headers })).json<StudioState>();
  const imported = await second.app.inject({ method: 'POST', url: '/api/room/profile', headers: second.headers, payload: profile });
  assert.equal(imported.statusCode, 200, imported.body);
  const room = imported.json<RoomConfig>();
  assert.equal(room.name, 'Studio Sion');
  assert.equal(room.captureSoftware, 'maya');
  assert.equal(room.obsUrl, 'ws://127.0.0.1:4460');
  assert.equal(room.obsPasswordConfigured, false);
  assert.equal(room.liveDestination.keyConfigured, false);
  assert.equal(room.studioId, before.room.studioId, 'Each studio keeps its own identity');
  assert.notEqual(room.studioId, (await first.app.inject({ method: 'GET', url: '/api/room', headers: first.headers })).json<RoomConfig>().studioId);
});

test('a profile clears secrets that would go to another software or another live server', async (t) => {
  const target = await studio(t, 'c');
  await target.app.inject({ method: 'PATCH', url: '/api/room', headers: target.headers, payload: {
    obsPassword: 'mot-de-passe-obs', liveDestination: { name: 'Twitch', server: 'rtmp://live.twitch.tv/app', key: 'cle-twitch' } } });
  const current = (await target.app.inject({ method: 'GET', url: '/api/room/profile', headers: target.headers })).json<StudioProfile>();

  const same = await target.app.inject({ method: 'POST', url: '/api/room/profile', headers: target.headers, payload: { ...current, room: { ...current.room, name: 'Renommé' } } });
  assert.equal(same.json<RoomConfig>().obsPasswordConfigured, true, 'Same software and address: the password stays');
  assert.equal(same.json<RoomConfig>().liveDestination.keyConfigured, true, 'Same live server: the key stays');

  const other = await target.app.inject({ method: 'POST', url: '/api/room/profile', headers: target.headers, payload: { ...current,
    room: { ...current.room, captureSoftware: 'maya', captureUrl: 'ws://127.0.0.1:4460', liveDestination: { name: 'YouTube', server: 'rtmps://a.rtmp.youtube.com/live2' } } } });
  assert.equal(other.statusCode, 200, other.body);
  assert.equal(other.json<RoomConfig>().obsPasswordConfigured, false);
  assert.equal(other.json<RoomConfig>().liveDestination.keyConfigured, false);
});

test('only a technician imports, and only a valid Nino profile', async (t) => {
  const target = await studio(t, 'd');
  const deck = (await target.app.inject({ method: 'POST', url: '/api/devices', headers: target.headers, payload: { kind: 'streamdeck', role: 'operator', name: 'Deck' } })).json();
  const profile = (await target.app.inject({ method: 'GET', url: '/api/room/profile', headers: target.headers })).json<StudioProfile>();
  assert.equal((await target.app.inject({ method: 'GET', url: '/api/room/profile', headers: { authorization: `Bearer ${deck.token}` } })).statusCode, 403);
  assert.equal((await target.app.inject({ method: 'POST', url: '/api/room/profile', headers: { authorization: `Bearer ${deck.token}` }, payload: profile })).statusCode, 403);
  const wrongKind = await target.app.inject({ method: 'POST', url: '/api/room/profile', headers: target.headers, payload: { ...profile, kind: 'autre' } });
  assert.equal(wrongKind.json().code, 'PROFILE_INVALID');
  const newer = await target.app.inject({ method: 'POST', url: '/api/room/profile', headers: target.headers, payload: { ...profile, version: 2 } });
  assert.equal(newer.json().code, 'PROFILE_VERSION');
  const remote = await target.app.inject({ method: 'POST', url: '/api/room/profile', headers: target.headers,
    payload: { ...profile, room: { ...profile.room, captureUrl: 'ws://10.0.0.5:4455' } } });
  assert.equal(remote.statusCode, 400, 'The capture software stays on the studio PC, even through a profile');
});
