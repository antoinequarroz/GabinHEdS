import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import type { MediaState, ObsState } from '@gabin/shared';
import { buildApp } from '../src/app.js';
import { emptyObsState, type ObsGateway } from '../src/obs.js';
import { emptyMediaState, type MediaGateway } from '../src/media.js';
import { Store } from '../src/store.js';
import { Studio } from '../src/studio.js';

const token = 'a'.repeat(43);
const headers = { host: '127.0.0.1:4310', authorization: `Bearer ${token}` };
function gateways(connected = true) {
  const state: ObsState = { ...emptyObsState(), connected };
  const mediaState: MediaState = { ...emptyMediaState(), available: true };
  const calls = { refresh: 0, fresh: false, mutations: 0, mediaRefresh: 0 };
  const mutate = async () => { calls.mutations++; };
  const obs: ObsGateway = {
    getState: () => structuredClone(state), connect: async () => structuredClone(state), disconnect: async () => {},
    refresh: async fresh => { calls.refresh++; calls.fresh = Boolean(fresh); return structuredClone(state); },
    subscribe: () => () => {}, sceneThumbnail: async sceneName => ({ sceneName, imageData: null, capturedAt: null, available: false }),
    setScene: mutate, setInputMute: mutate, setRecordDirectory: mutate, startRecord: mutate,
    stopRecord: async () => { await mutate(); return { outputPath: null }; }, pauseRecord: mutate, resumeRecord: mutate,
    configureLocalFeed: mutate, startStream: mutate, stopStream: mutate,
  };
  const media: MediaGateway = {
    getState: () => structuredClone(mediaState), refresh: async () => { calls.mediaRefresh++; return structuredClone(mediaState); },
    ingestSettings: () => ({ server: 'rtmp://127.0.0.1:1935/gabin', key: 'program' }),
    startLive: mutate, stopLive: mutate, hlsResource: async () => new Response(), subscribe: () => () => {}, close: async () => {},
  };
  return { obs, media, state, mediaState, calls };
}
async function fixture(t: TestContext, options: { enabled?: boolean; connected?: boolean } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nino-local-lifecycle-'));
  const gateway = gateways(options.connected ?? true);
  let shutdowns = 0;
  const app = await buildApp({ dataDir, obs: gateway.obs, media: gateway.media,
    localLifecycle: options.enabled === false ? undefined : { token, onShutdown: () => { shutdowns++; } } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const stop = (extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/local-shutdown', headers, ...extra });
  return { app, stop, gateway, shutdowns: () => shutdowns };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('local lifecycle is absent by default and launcher tokens grant no device access', async t => {
  const { app, stop, shutdowns } = await fixture(t, { enabled: false });
  assert.equal((await stop()).statusCode, 401);
  const auth = (await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost' } })).json();
  assert.equal((await stop({ headers: { ...headers, authorization: `Bearer ${auth.token}` } })).statusCode, 404);
  assert.equal(shutdowns(), 0);
});

test('local lifecycle accepts only the separate native loopback launcher credential', async t => {
  const { app, stop, shutdowns, gateway } = await fixture(t);
  assert.equal((await app.inject({ url: '/api/state', headers })).statusCode, 401);
  for (const authorization of ['', 'Bearer wrong', 'Basic anything']) {
    const reply = await stop({ headers: { ...headers, authorization } });
    assert.equal(reply.statusCode, 401);
    assert.equal(reply.body.includes(token), false);
  }
  for (const extra of [
    { headers: { ...headers, origin: 'http://127.0.0.1:4310' } },
    { headers: { ...headers, origin: 'https://foreign.example' } },
    { headers: { ...headers, host: 'room.example:4310' } },
    { headers: { ...headers, forwarded: 'for=127.0.0.1' } },
    { headers: { ...headers, 'x-forwarded-for': '127.0.0.1' } },
    { headers: { ...headers, 'x-forwarded-proto': 'https' } },
    { remoteAddress: '192.168.1.20' },
  ]) assert.equal((await stop(extra)).statusCode, 403);
  assert.equal(shutdowns(), 0);
  assert.equal(gateway.calls.refresh, 0);
  assert.equal(gateway.calls.mutations, 0);
});

test('idle shutdown confirms fresh outputs, acknowledges, then drains further requests', async t => {
  const { app, stop, shutdowns, gateway } = await fixture(t);
  const response = await stop();
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { accepted: true, status: 'stopping' });
  await flush();
  assert.equal(shutdowns(), 1);
  assert.equal(gateway.calls.refresh, 1);
  assert.equal(gateway.calls.fresh, true);
  assert.ok(gateway.calls.mediaRefresh >= 1);
  assert.equal(gateway.calls.mutations, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost' } })).statusCode, 503);
  assert.equal((await stop()).statusCode, 503);
  assert.equal(shutdowns(), 1);
});

test('recording, paused, OBS transport and live transitions all refuse shutdown', async t => {
  const { stop, shutdowns, gateway } = await fixture(t);
  for (const field of ['recording', 'paused', 'streaming', 'streamReconnecting'] as const) {
    gateway.state[field] = true;
    assert.equal((await stop()).statusCode, 409, field);
    gateway.state[field] = false;
  }
  for (const phase of ['starting', 'live', 'stopping', 'error'] as const) {
    gateway.mediaState.liveStatus = phase;
    assert.equal((await stop()).statusCode, 409, phase);
  }
  assert.equal(shutdowns(), 0);
  assert.equal(gateway.calls.mutations, 0);
});

test('OBS errors and failed refreshes refuse shutdown without changing outputs', async t => {
  const { stop, shutdowns, gateway } = await fixture(t);
  gateway.state.error = 'OBS connection unknown';
  assert.equal((await stop()).statusCode, 409);
  gateway.state.error = null;
  gateway.obs.refresh = async () => { throw new Error('connection lost'); };
  assert.equal((await stop()).statusCode, 409);
  assert.equal(shutdowns(), 0);
  assert.equal(gateway.calls.mutations, 0);
});

test('a pristine first install can stop before OBS configuration; project history cannot', async t => {
  const fresh = await fixture(t, { connected: false });
  assert.equal((await fresh.stop()).statusCode, 202);
  await flush();
  assert.equal(fresh.shutdowns(), 1);
  const historical = await fixture(t, { connected: false });
  const auth = (await historical.app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost' } })).json();
  const created = await historical.app.inject({ method: 'POST', url: '/api/projects',
    headers: { authorization: `Bearer ${auth.token}` }, payload: { title: 'Existing production', format: 'podcast' } });
  assert.equal(created.statusCode, 201);
  assert.equal((await historical.stop()).statusCode, 409);
  assert.equal(historical.shutdowns(), 0);
});

test('pending takes prevent shutdown and draining rejects already queued commands', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nino-local-drain-'));
  const gateway = gateways();
  const store = new Store(dataDir);
  const studio = new Studio(store, gateway.obs, gateway.media, { autoIntervalMs: 0 });
  t.after(async () => { await studio.close(); await rm(dataDir, { recursive: true, force: true }); });
  store.setSetting('pendingTake', { id: 'uncertain' });
  await assert.rejects(studio.serial(() => studio.prepareLocalShutdown()), { code: 'LOCAL_SHUTDOWN_BUSY' });
  store.setSetting('pendingTake', null);
  const accepted = studio.serial(() => studio.prepareLocalShutdown());
  let ran = false;
  const queued = studio.serial(() => { ran = true; });
  await accepted;
  await assert.rejects(queued, { code: 'LOCAL_SHUTDOWN_DRAINING' });
  assert.equal(ran, false);
  assert.equal(gateway.calls.mutations, 0);
});

test('a recovered pending take still prevents the disconnected first-install exception', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nino-local-history-'));
  const gateway = gateways(false);
  const store = new Store(dataDir);
  store.setSetting('pendingTake', { id: 'previous-process-uncertainty' });
  const studio = new Studio(store, gateway.obs, gateway.media, { autoIntervalMs: 0 });
  t.after(async () => { await studio.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal(store.setting('pendingTake'), null, 'Normal startup recovery clears this setting.');
  await assert.rejects(studio.serial(() => studio.prepareLocalShutdown()), { code: 'LOCAL_SHUTDOWN_BUSY' });
});

test('a real HTTP acknowledgement arrives before the native shutdown closes the listener', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nino-local-http-'));
  const gateway = gateways();
  let closed!: () => void;
  const closedPromise = new Promise<void>(resolve => { closed = resolve; });
  const app = await buildApp({ dataDir, obs: gateway.obs, media: gateway.media,
    localLifecycle: { token, onShutdown: async () => { await app.close(); closed(); } } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/local-shutdown`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, status: 'stopping' });
  await closedPromise;
  assert.equal(app.server.listening, false);
  assert.equal(gateway.calls.mutations, 0);
});
