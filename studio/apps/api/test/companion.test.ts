import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import type { StudioState } from '@gabin/shared';
import { companionBindings, companionFeedback, CompanionBridge, type CompanionStatus } from '../src/companion.js';
import { emptyObsState } from '../src/obs.js';
import { emptyMediaState } from '../src/media.js';

const fixture = (): StudioState => ({
  revision: 1,
  room: { name: 'Salle', obsUrl: '', obsPasswordConfigured: false, recordingRoot: '/tmp', defaultScenes: { podcast: 'Wide', roundtable: 'Wide', slides: 'Share' }, liveDestination: { name: '', server: '', keyConfigured: false } },
  obs: { ...emptyObsState(), connected: true, scenes: ['Cam 1', 'Cam 2', 'Wide', 'Share', 'Mire'], currentScene: 'Cam 1', inputs: [{ name: 'Mic 1', kind: 'audio', muted: false, volumeDb: 0 }] },
  media: emptyMediaState(),
  projects: [{ id: 'one', title: 'Podcast', description: '', owner: '', format: 'podcast', status: 'ready', createdAt: '', updatedAt: '', defaultScene: 'Wide', participants: [{ id: 'p1', name: 'Alice', micInput: 'Mic 1', sceneName: 'Cam 1' }, { id: 'p2', name: 'Bob', micInput: 'Missing mic', sceneName: 'Missing cam' }] },
    { id: 'two', title: 'Table ronde', description: '', owner: '', format: 'roundtable', status: 'ready', createdAt: '', updatedAt: '', defaultScene: 'Wide', participants: [] }],
  takes: [], activeTake: null, liveProjectId: null, markers: [],
  library: [{ id: 'intro', title: 'Intro', kind: 'video', mimeType: 'video/mp4', originalName: 'intro.mp4', sizeBytes: 10, durationMs: 2000, width: 1920, height: 1080, createdAt: '', archivedAt: null }],
  projectMedia: { one: [{ assetId: 'intro', role: 'intro', order: 0 }] },
  autoDirectionSettings: { one: { wideScene: 'Wide', thresholdDb: -38, dominanceDb: 6, confirmationMs: 500, minShotMs: 1000, silenceMs: 1500, overlapMs: 700 } },
  streamDeck: { projectId: 'one', companionConnected: false, syncedProjectId: null, error: null },
});

test('bindings contain only valid sources belonging to the selected production', () => {
  const state = fixture();
  const bindings = companionBindings(state, 'one', { projectId: 'one', share: 'Share', mire: 'Mire' });
  assert.equal(bindings.nino_suite_camera_1, 'Cam 1');
  assert.equal(bindings.nino_suite_camera_2, '');
  assert.equal(bindings.nino_suite_mic_2, '');
  assert.equal(bindings.nino_suite_share, 'Share');
  assert.equal(bindings.nino_suite_wide, 'Wide');
  assert.equal(bindings.nino_suite_asset_intro, 'intro');
  assert.equal(companionBindings(state, 'two', { projectId: 'one', share: 'Share' }).nino_suite_share, '');
  state.projectMedia!.one.push({ assetId: 'intro', role: 'intro', order: 1 });
  assert.equal(companionBindings(state, 'one').nino_suite_asset_intro, '', 'an ambiguous role must not choose silently');
  state.projects[0].status = 'archived';
  assert.equal(companionBindings(state, 'one').nino_suite_binding_project_id, '');
});

test('feedback reports observed OBS and public live state, and fails closed for unknown inputs', () => {
  const state = fixture(); const bindings = companionBindings(state, 'one');
  state.obs.recording = state.obs.paused = state.obs.streaming = true;
  state.obs.timecode = '00:01:23.456';
  state.media.liveStatus = 'idle';
  const feedback = companionFeedback(state, 'one', bindings, 25_000);
  assert.equal(feedback.nino_state_recording, 1);
  assert.equal(feedback.nino_state_paused, 1);
  assert.equal(feedback.nino_state_record_timecode, '00:01:23');
  assert.equal(feedback.nino_state_live_status, 'idle', 'OBS local publishing is not a public live');
  assert.equal(feedback.nino_state_mic_1, 'open');
  assert.equal(feedback.nino_state_mic_2, 'unknown');
  assert.equal(feedback.nino_state_updated_at, 25);
  state.obs.connected = false;
  const disconnected = companionFeedback(state, 'one', bindings);
  assert.equal(disconnected.nino_state_recording, 0);
  assert.equal(disconnected.nino_state_record_timecode, '');
  assert.equal(disconnected.nino_state_mic_1, 'unknown');
  state.obs.connected = true; state.obs.error = 'Actualisation OBS impossible';
  assert.equal(companionFeedback(state, 'one', bindings).nino_state_recording, 0, 'a stale connected cache is not confirmed recording');
});

test('software opening capability fails closed for older API states and does not require OBS or a selected production', () => {
  const state = fixture();
  state.obs.connected = false; state.projects = [];
  const bindings = companionBindings(state, null);
  assert.equal(companionFeedback(state, null, bindings).nino_state_studio_open_available, 0, 'An older API without this capability cannot enable the welcome action');
  state.studioOpenAvailable = false;
  assert.equal(companionFeedback(state, null, bindings).nino_state_studio_open_available, 0);
  state.studioOpenAvailable = true;
  const feedback = companionFeedback(state, null, bindings);
  assert.equal(feedback.nino_state_studio_open_available, 1); assert.equal(feedback.nino_state_obs_connected, 0); assert.equal(feedback.nino_state_project_id, '');
});

test('another production or an external recording disarms this production without changing selection', () => {
  const state = fixture(); const bindings = companionBindings(state, 'one');
  state.obs.recording = true;
  assert.equal(companionFeedback(state, 'one', bindings).nino_state_project_conflict, 1, 'external OBS recording has no trusted project');
  state.activeTake = { id: 'take', projectId: 'two', sequence: 1, title: 'Other take', status: 'recording', startedAt: '', endedAt: null, outputPath: null, recordingDirectory: '/tmp', durationMs: 0 };
  assert.equal(companionFeedback(state, 'one', bindings).nino_state_project_conflict, 1, 'another production owns the take');
  state.activeTake.projectId = 'one';
  assert.equal(companionFeedback(state, 'one', bindings).nino_state_project_conflict, 0, 'the selected production may control its own take');
  state.activeTake = null;
  state.obs.recording = false;
  state.liveProjectId = 'two'; state.media.liveStatus = 'live';
  assert.equal(companionFeedback(state, 'one', bindings).nino_state_project_conflict, 1);
  state.media.liveStatus = 'idle'; state.liveProjectId = null;
  state.launch = { id: 'launch', projectId: 'two', takeId: null, includeLive: false, status: 'running', step: 'preparing', message: '', updatedAt: null };
  assert.equal(companionFeedback(state, 'one', bindings).nino_state_project_conflict, 1);
  state.launch.status = 'completed'; state.obs.streaming = true;
  assert.equal(companionFeedback(state, 'one', bindings).nino_state_project_conflict, 0, 'local return publishing alone is not a project conflict');
  assert.equal(companionFeedback(state, 'one', bindings).nino_state_project_id, 'one');
});

interface Call { method: string; path: string; input: { name: string; value?: string | number | boolean; defaultVal?: string }; }
async function fakeCompanion(t: TestContext) {
  const values = new Map<string, string | number>([['nino_suite_binding_project_id', 'one'], ['nino_suite_share', 'Share'], ['nino_suite_mire', 'Mire'], ['nino_token', 'never-read-or-modify']]);
  const calls: Call[] = []; const requests: string[] = []; const sockets = new Set<WebSocket>();
  let beforeReply: ((call: Call) => void) | undefined;
  const server = createServer((request, response) => {
    requests.push(request.url || '');
    const name = request.url?.split('/')[3] || '';
    if (!values.has(name)) { response.writeHead(404).end(); return; }
    response.end(String(values.get(name)));
  });
  const wss = new WebSocketServer({ server, path: '/trpc' });
  wss.on('connection', (socket, request) => {
    assert.equal(request.headers.origin, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      const call = { method: message.method, ...message.params } as Call;
      calls.push(call); beforeReply?.(call);
      let result: unknown = null;
      if (call.path === 'customVariables.create') {
        if (values.has(call.input.name)) result = `Variable "${call.input.name}" already exists`;
        else values.set(call.input.name, call.input.defaultVal || '');
      } else if (call.path === 'customVariables.setCurrent') values.set(call.input.name, call.input.value as string | number);
      if (socket.readyState === 1) socket.send(JSON.stringify({ id: message.id, result: { type: 'data', data: result } }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  t.after(async () => { for (const socket of sockets) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { values, calls, requests, sockets, url: `ws://127.0.0.1:${port}/trpc`, setBeforeReply: (callback: typeof beforeReply) => { beforeReply = callback; } };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 150; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Timed out waiting for the isolated Companion bridge');
}

test('bridge disarms before binding and arms last, never reads credentials, updates feedback without commands', async t => {
  let now = 25_000;
  t.mock.method(Date, 'now', () => now);
  const companion = await fakeCompanion(t); const state = fixture();
  const statuses: CompanionStatus[] = [];
  const bridge = new CompanionBridge({ getState: () => state, onStatus: status => statuses.push(status), url: companion.url, intervalMs: 60_000, rpcTimeoutMs: 200 });
  t.after(() => bridge.stop()); bridge.start();
  await until(() => statuses.at(-1)?.syncedProjectId === 'one');
  const writes = companion.calls.filter(call => call.path === 'customVariables.setCurrent');
  assert.deepEqual(writes[0].input, { name: 'nino_suite_binding_project_id', value: '' });
  const arm = writes.findIndex(call => call.input.name === 'nino_suite_binding_project_id' && call.input.value === 'one');
  const lastBinding = writes.findLastIndex(call => call.input.name.startsWith('nino_suite_') && call.input.name !== 'nino_suite_binding_project_id');
  assert.ok(arm > lastBinding, 'binding project is armed after every source/media write');
  assert.ok(companion.calls.every(call => call.method === 'mutation' && call.path.startsWith('customVariables.')));
  assert.ok(companion.calls.every(call => call.input.name !== 'nino_token'));
  assert.ok(companion.requests.every(path => !path.includes('nino_token') && path.startsWith('/api/custom-variable/nino_suite_')));
  assert.equal(companion.values.get('nino_token'), 'never-read-or-modify');
  const beforeHeartbeat = companion.calls.length;
  now += 1000; bridge.refresh();
  await until(() => companion.values.get('nino_state_updated_at') === 26);
  // Let the response and the remaining resolved variable writes finish in the
  // event loop; wall-clock time is fixed and no arbitrary sleep is needed.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(companion.calls.slice(beforeHeartbeat), [{ method: 'mutation', path: 'customVariables.setCurrent', input: { name: 'nino_state_updated_at', value: 26 } }],
    'the next second rewrites only the heartbeat, with its exact observed value');
  const beforeUnchanged = companion.calls.length;
  bridge.refresh(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(companion.calls.length, beforeUnchanged, 'unchanged state and heartbeat are not rewritten');
  state.obs.inputs[0].muted = true; bridge.refresh();
  await until(() => companion.values.get('nino_state_mic_1') === 'muted');
  await bridge.stop();
  assert.equal(companion.values.get('nino_state_online'), 0);
  assert.equal(companion.values.get('nino_suite_binding_project_id'), '');
});

test('a selection changed during synchronization is never armed with stale bindings', async t => {
  const companion = await fakeCompanion(t); const state = fixture(); const statuses: CompanionStatus[] = [];
  const bridge = new CompanionBridge({ getState: () => state, onStatus: status => statuses.push(status), url: companion.url, intervalMs: 60_000, rpcTimeoutMs: 200 });
  t.after(() => bridge.stop());
  let switched = false;
  companion.setBeforeReply(call => { if (!switched && call.path === 'customVariables.setCurrent' && call.input.name === 'nino_suite_camera_1') { switched = true; bridge.select('two'); } });
  bridge.start(); await until(() => statuses.at(-1)?.syncedProjectId === 'two');
  assert.equal(companion.values.get('nino_project_id'), 'two');
  assert.equal(companion.values.get('nino_suite_asset_intro'), '');
  assert.ok(!companion.calls.some(call => call.path === 'customVariables.setCurrent' && call.input.name === 'nino_suite_binding_project_id' && call.input.value === 'one'));
});

test('presentation scene survives switching productions and a clean bridge restart', async t => {
  const companion = await fakeCompanion(t); const state = fixture(); let status: CompanionStatus | null = null;
  const makeBridge = () => new CompanionBridge({ getState: () => state, onStatus: next => { status = next; }, url: companion.url, intervalMs: 60_000, rpcTimeoutMs: 200 });
  let bridge = makeBridge(); t.after(() => bridge.stop()); bridge.start();
  await until(() => status?.syncedProjectId === 'one');
  assert.equal(companion.values.get('nino_suite_share'), 'Share');
  bridge.select('two'); await until(() => status?.syncedProjectId === 'two');
  assert.equal(companion.values.get('nino_suite_share'), '');
  bridge.select('one'); await until(() => status?.syncedProjectId === 'one');
  assert.equal(companion.values.get('nino_suite_share'), 'Share');
  await bridge.stop(); bridge = makeBridge(); bridge.start();
  await until(() => status?.syncedProjectId === 'one');
  assert.equal(companion.values.get('nino_suite_share'), 'Share');
});

test('a selection changed at the final binding writes is never reported as synchronized', async t => {
  const companion = await fakeCompanion(t); const state = fixture(); const statuses: CompanionStatus[] = [];
  const bridge = new CompanionBridge({ getState: () => state, onStatus: status => statuses.push(status), url: companion.url, intervalMs: 60_000, rpcTimeoutMs: 200 });
  t.after(() => bridge.stop());
  let switched = false;
  companion.setBeforeReply(call => {
    if (!switched && call.path === 'customVariables.setCurrent' && call.input.name === 'nino_suite_binding_project_id' && call.input.value === 'one') {
      switched = true; bridge.select('two');
    }
  });
  bridge.start(); await until(() => statuses.at(-1)?.syncedProjectId === 'two');
  assert.ok(!statuses.some(status => status.syncedProjectId === 'one'));
  assert.equal(companion.values.get('nino_suite_binding_project_id'), 'two');
});

test('a crash during standalone scene writes cannot overwrite the persisted presentation owner map', async t => {
  const companion = await fakeCompanion(t); const state = fixture(); let status: CompanionStatus | null = null;
  companion.values.set('nino_suite_binding_project_id', '');
  companion.values.set('nino_suite_share_project_id', 'one');
  companion.values.set('nino_suite_share', 'Wide'); // write from another unfinished selection
  companion.values.set('nino_suite_presentation_scenes', JSON.stringify({ one: 'Share' }));
  const bridge = new CompanionBridge({ getState: () => state, onStatus: next => { status = next; }, url: companion.url, intervalMs: 60_000, rpcTimeoutMs: 200 });
  t.after(() => bridge.stop()); bridge.start();
  await until(() => status?.syncedProjectId === 'one');
  assert.equal(companion.values.get('nino_suite_share'), 'Share');
});

test('starting while OBS is disconnected preserves presentation and test-card scenes until reconnect', async t => {
  const companion = await fakeCompanion(t); const state = fixture(); let status: CompanionStatus | null = null;
  state.obs.connected = false; state.obs.scenes = [];
  const bridge = new CompanionBridge({ getState: () => state, onStatus: next => { status = next; }, url: companion.url, intervalMs: 60_000, rpcTimeoutMs: 200 });
  t.after(() => bridge.stop()); bridge.start();
  await until(() => status?.syncedProjectId === 'one');
  assert.equal(companion.values.get('nino_suite_share'), '');
  state.obs.connected = true; state.obs.scenes = ['Cam 1', 'Cam 2', 'Wide', 'Share', 'Mire']; bridge.refresh();
  await until(() => companion.values.get('nino_suite_binding_project_id') === 'one' && companion.values.get('nino_suite_share') === 'Share');
  assert.equal(companion.values.get('nino_suite_mire'), 'Mire');
});

test('socket loss clears the public status and reconnects without production actions', async t => {
  const companion = await fakeCompanion(t); const state = fixture(); const statuses: CompanionStatus[] = [];
  const bridge = new CompanionBridge({ getState: () => state, onStatus: status => statuses.push(status), url: companion.url, intervalMs: 60_000, rpcTimeoutMs: 200, reconnectMs: 15 });
  t.after(() => bridge.stop()); bridge.start();
  await until(() => statuses.at(-1)?.syncedProjectId === 'one');
  for (const socket of companion.sockets) socket.terminate();
  await until(() => statuses.some(status => !status.connected && status.error !== null));
  await until(() => statuses.at(-1)?.syncedProjectId === 'one');
  assert.ok(companion.calls.every(call => call.path.startsWith('customVariables.')));
});

test('bridge cannot connect to a remote or credential-bearing endpoint', () => {
  for (const url of ['ws://example.com:8000/trpc', 'ws://user:password@127.0.0.1:8000/trpc', 'ws://127.0.0.1:8000/other']) {
    assert.throws(() => new CompanionBridge({ getState: fixture, onStatus() {}, url }));
  }
});
