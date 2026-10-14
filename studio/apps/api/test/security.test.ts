import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { roomInput, projectInput, controlInput } from '../src/validation.js';
import { audioFrame } from '../src/obs.js';

test('configuration rejects remote OBS and invalid projects/control', () => {
  for (const obsUrl of ['ws://example.com:4455', 'http://127.0.0.1:4455', 'ws://localhost:4455/?secret=1', 'ws://user:password@localhost:4455']) {
    assert.throws(() => roomInput({ obsUrl }));
  }
  assert.equal(roomInput({ obsUrl: 'ws://127.0.0.1:4455' }).obsUrl, 'ws://127.0.0.1:4455');
  assert.throws(() => projectInput({ title: ' ', format: 'podcast' }));
  assert.throws(() => controlInput({ action: 'input.mute', inputName: 'Micro', muted: 'true' }));
  assert.throws(() => controlInput({ action: 'record.toggle' }));
  assert.deepEqual(controlInput({ action: 'record.stop' }), { action: 'record.stop', requestId: undefined });
  assert.deepEqual(controlInput({ action: 'preview.start' }), { action: 'preview.start', requestId: undefined });
  assert.throws(() => roomInput({ liveDestination: { name: 'Live', server: 'https://example.com/stream', key: 'secret' } }));
  assert.throws(() => roomInput({ liveDestination: { name: 'Live', server: 'rtmp://user:secret@example.com/live', key: 'secret' } }));
});

test('local bootstrap, one-use pairing, roles and revocation', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gabin-auth-'));
  const app = await buildApp({ dataDir });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal((await app.inject({ method: 'GET', url: '/api/state' })).statusCode, 401);
  const ipadPage = await app.inject({ method: 'GET', url: '/', headers: { host: 'ipad.gabin.test:4310' } });
  assert.match(String(ipadPage.headers['content-security-policy']), /connect-src 'self' ws:\/\/ipad\.gabin\.test:4310 wss:\/\/ipad\.gabin\.test:4310;/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'studio.example', origin: 'http://studio.example' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost', 'x-forwarded-for': '192.168.1.5' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost', origin: 'https://evil.example' } })).statusCode, 403);
  const auth = (await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost' } })).json();
  assert.equal(auth.device.role, 'technician');
  const headers = { authorization: `Bearer ${auth.token}` };
  const pairing = (await app.inject({ method: 'POST', url: '/api/pairing', headers, payload: { role: 'viewer', kind: 'ipad' } })).json();
  const paired = (await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: pairing.code, name: 'iPad', kind: 'ipad' } })).json();
  assert.equal(paired.device.role, 'viewer');
  const viewerHeaders = { authorization: `Bearer ${paired.token}` };
  assert.equal((await app.inject({ method: 'GET', url: '/api/state', headers: viewerHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', headers: viewerHeaders, payload: { title: 'Projet', format: 'podcast' } })).statusCode, 403);
  for (const action of ['preview.start', 'preview.stop', 'stream.stop']) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/control', headers: viewerHeaders, payload: { action } })).statusCode, 403);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/control', headers: viewerHeaders, payload: { action: 'stream.start', projectId: 'project' } })).statusCode, 403);
  const deck = (await app.inject({ method: 'POST', url: '/api/devices', headers, payload: { kind: 'streamdeck', role: 'operator', name: 'Stream Deck' } })).json();
  const deckHeaders = { authorization: `Bearer ${deck.token}` };
  assert.equal((await app.inject({ method: 'POST', url: '/api/control', headers: deckHeaders, payload: { action: 'stream.stop' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/room', headers: deckHeaders, payload: { liveDestination: { name: 'Direct', server: 'rtmp://example.com/live', key: 'secret' } } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: pairing.code, name: 'iPad 2', kind: 'ipad' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/devices/${paired.device.id}`, headers })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: '/api/state', headers: viewerHeaders })).statusCode, 401);
  const privateRoom = { obsPassword: 'private-obs-password', liveDestination: { name: 'YouTube', server: 'rtmps://example.com/live', key: 'private-stream-key' } };
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/room', headers, payload: privateRoom })).statusCode, 200);
  const state = (await app.inject({ method: 'GET', url: '/api/state', headers })).body;
  assert.equal(state.includes('private-obs-password'), false);
  assert.equal(state.includes('private-stream-key'), false);
  assert.equal(JSON.parse(state).room.liveDestination.keyConfigured, true);
  const database = await readFile(path.join(dataDir, 'studio.sqlite'));
  assert.equal(database.includes(Buffer.from(auth.token)), false);
  assert.equal(database.includes(Buffer.from(pairing.code)), false);
  assert.equal((await stat(path.join(dataDir, 'studio.sqlite'))).mode & 0o777, 0o600);
});

test('audio meters convert real post-fader amplitude, ignore raw pre-fader peak and invalid channels', () => {
  const frame = audioFrame([
    { inputName: 'Micro', inputLevelsMul: [[0.1, 0.5, 1.1], [0.2, 0.25, 1]] },
    { inputName: 'Silence', inputLevelsMul: [[0, 0, 1]] },
    { inputName: 'Invalid', inputLevelsMul: [[NaN, 1, 1]] },
  ], 1000);
  assert.equal(frame.capturedAt, new Date(1000).toISOString());
  assert.equal(frame.inputs.length, 2);
  assert.ok(Math.abs(frame.inputs[0]!.rmsDb - 20 * Math.log10(0.2)) < 0.00001);
  assert.ok(Math.abs(frame.inputs[0]!.peakDb - 20 * Math.log10(0.5)) < 0.00001);
  assert.equal(frame.inputs[1]!.peakDb, -100);
});
