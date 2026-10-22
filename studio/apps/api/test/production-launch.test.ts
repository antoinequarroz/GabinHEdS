import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MediaAsset, MediaPlayback, MediaState, ObsState } from '@gabin/shared';
import { Studio } from '../src/studio.js';
import { Store } from '../src/store.js';
import { emptyObsState, type ObsEvent, type ObsGateway, type ObsMediaOptions } from '../src/obs.js';
import { emptyMediaState, type MediaGateway } from '../src/media.js';
import { buildApp } from '../src/app.js';
import { controlInput } from '../src/validation.js';

class ObsFixture implements ObsGateway {
  state: ObsState = { ...emptyObsState(), connected: true, scenes: ['Podcast', 'Caméra', 'Large', 'Nino · Médias'], currentScene: 'Podcast', inputs: [{ name: 'Micro', kind: 'audio', muted: false, volumeDb: 0 }] };
  playback: MediaPlayback | null = null;
  starts = 0; stops = 0; previewStarts = 0; mediaStops = 0;
  calls: string[] = [];
  private previousScene: string | null = null;
  private listeners = new Set<(event: ObsEvent) => void>();
  getState() { return structuredClone(this.state); }
  getMediaPlayback() { return structuredClone(this.playback); }
  subscribe(fn: (event: ObsEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event: ObsEvent) { for (const fn of this.listeners) fn(event); }
  async connect() { this.state.connected = true; return this.refresh(); }
  async disconnect() { this.state.connected = false; }
  async refresh() { return this.getState(); }
  async sceneThumbnail(sceneName: string) { return { sceneName, imageData: null, capturedAt: null, available: false }; }
  async setScene(sceneName: string) { this.calls.push(`scene:${sceneName}`); this.state.currentScene = sceneName; }
  async setInputMute(inputName: string, muted: boolean) { this.state.inputs.find(input => input.name === inputName)!.muted = muted; }
  async setRecordDirectory(directory: string) { this.state.recordingDirectory = directory; }
  async startRecord() { this.starts++; this.calls.push('record'); this.state.recording = true; }
  async stopRecord() { this.stops++; this.state.recording = false; return { outputPath: path.join(this.state.recordingDirectory!, 'test.mkv') }; }
  async pauseRecord() { this.state.paused = true; }
  async resumeRecord() { this.state.paused = false; }
  async configureLocalFeed() { this.calls.push('feed'); }
  async startStream() { this.previewStarts++; this.calls.push('preview'); this.state.streaming = true; }
  async stopStream() { this.state.streaming = false; }
  async playMedia(options: ObsMediaOptions) {
    assert.equal(this.state.recording, true, 'The intro never starts before OBS recording confirmation');
    this.calls.push('intro'); this.previousScene = this.state.currentScene; this.state.currentScene = 'Nino · Médias';
    this.playback = { assetId: options.assetId, mode: options.mode, status: 'playing', sceneName: 'Nino · Médias', error: null };
    return this.getMediaPlayback()!;
  }
  async mediaAction(action: 'pause' | 'resume' | 'stop') {
    if (action === 'stop') { this.mediaStops++; this.calls.push('media.stop'); this.state.currentScene = this.previousScene; }
    this.playback!.status = action === 'pause' ? 'paused' : action === 'resume' ? 'playing' : 'stopped';
    return this.getMediaPlayback()!;
  }
}
class MediaFixture implements MediaGateway {
  state: MediaState = { ...emptyMediaState(), available: true };
  liveStarts = 0;
  getState() { return structuredClone(this.state); }
  async refresh() { this.state.previewReady = true; return this.getState(); }
  ingestSettings() { return { server: 'rtmp://127.0.0.1:1935/gabin', key: 'program' }; }
  async startLive() { this.liveStarts++; this.state.liveStatus = 'live'; }
  async stopLive() { this.state.liveStatus = 'idle'; }
  async hlsResource() { return new Response(''); }
  subscribe() { return () => undefined; }
  async close() {}
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), message);
}
async function fixture(t: TestContext, intro = false, options: { studioOpener?: () => Promise<void> } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nino-production-launch-'));
  const store = new Store(path.join(directory, 'db')); const obs = new ObsFixture(); const media = new MediaFixture();
  const studio = new Studio(store, obs, media, { autoIntervalMs: 0, ...options });
  studio.updateRoom({ recordingRoot: path.join(directory, 'recordings') });
  const project = studio.createProject({ title: 'Épisode', format: 'podcast', participants: [{ id: 'one', name: 'Alice', micInput: 'Micro', sceneName: 'Caméra' }] });
  const auth = store.createDevice('MK.2', 'streamdeck', 'operator', true); const actor = { deviceId: auth.device.id };
  if (intro) {
    const id = randomUUID(); const fileName = `${id}.mp4`;
    const data = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
    await mkdir(path.join(store.dataDir, 'library')); await writeFile(path.join(store.dataDir, 'library', fileName), data);
    const asset: MediaAsset = { id, title: 'Intro', originalName: 'intro.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: data.length, createdAt: new Date().toISOString(), archivedAt: null, durationMs: 100, width: 1920, height: 1080 };
    store.put('mediaAsset', { id, asset, fileName, sha256: '' }); store.put('projectMedia', { id: project.id, links: [{ assetId: id, role: 'intro', order: 0 }] });
  }
  t.after(async () => { await studio.close(); await rm(directory, { recursive: true, force: true }); });
  return { studio, store, obs, media, project, auth, actor, directory };
}

test('production.start is explicit about live, requires an operator, and validates its includeLive flag', async t => {
  const { studio, project, actor, obs } = await fixture(t);
  for (const includeLive of ['false', 1, null]) assert.throws(() => controlInput({ action: 'production.start', projectId: project.id, includeLive }), { statusCode: 400 });
  assert.equal((controlInput({ action: 'production.start', projectId: project.id }) as { includeLive: boolean }).includeLive, false);
  const beforeUnauthorized = structuredClone(studio.state().launch);
  await assert.rejects(studio.serial(() => studio.control({ action: 'production.start', projectId: project.id })), { code: 'LAUNCH_AUTH_REQUIRED' });
  assert.deepEqual(studio.state().launch, beforeUnauthorized, 'An unauthorized request cannot replace public launch state');
  await assert.rejects(studio.serial(() => studio.control({ action: 'production.start', projectId: project.id, includeLive: true }, actor)), { code: 'LIVE_NOT_CONFIGURED' });
  assert.equal(obs.starts, 0);
});

test('a hardware preflight failure is published to subscribers and retains the actionable reason without starting outputs', async t => {
  const { studio, store, obs, media, project, actor } = await fixture(t);
  const failures: string[] = [];
  const unsubscribe = studio.subscribe(state => { if (state.launch?.status === 'failed') failures.push(state.launch.message); });
  t.after(unsubscribe);
  obs.state.inputs[0].muted = true;
  await assert.rejects(studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor)), { code: 'PREPARATION_BLOCKED' });
  assert.equal(studio.state().launch?.status, 'failed'); assert.equal(studio.state().launch?.step, 'preparing');
  assert.equal(studio.state().launch?.projectId, project.id); assert.equal(studio.state().launch?.takeId, null);
  assert.match(studio.state().launch!.message, /Micro absent, non audio ou coupé/);
  assert.equal(failures.at(-1), studio.state().launch!.message);
  assert.equal(store.setting<{ status: string }>('productionLaunch')?.status, 'failed');
  assert.equal(obs.starts, 0); assert.equal(obs.previewStarts, 0); assert.equal(media.liveStarts, 0);
  const failed = structuredClone(studio.state().launch);
  const viewer = store.createDevice('Lecture seule', 'ipad', 'viewer');
  await assert.rejects(studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, { deviceId: viewer.device.id })), { code: 'LAUNCH_AUTH_REQUIRED' });
  assert.deepEqual(studio.state().launch, failed, 'A viewer does not overwrite the last real failure');
});

test('the confirmed launch records before intro, waits for OBS media end, returns to its scene and enables configured auto without public live', async t => {
  const { studio, obs, media, project, actor } = await fixture(t, true);
  await studio.serial(() => studio.control({ action: 'auto.configure', projectId: project.id, settings: { wideScene: 'Large', thresholdDb: -38, dominanceDb: 6, confirmationMs: 600, minShotMs: 1000, silenceMs: 1500, overlapMs: 700 } }, actor));
  const accepted = await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
  assert.equal(accepted.launch?.status, 'running');
  await until(() => !!obs.playback, 'intro begins');
  assert.ok(studio.state().launch?.takeId);
  assert.equal(studio.state().launch?.status, 'running', 'Elapsed duration alone never claims OBS has ended a clip');
  obs.playback!.status = 'stopped';
  await until(() => studio.state().launch?.status === 'completed', 'launch finishes');
  assert.equal(obs.starts, 1); assert.equal(obs.mediaStops, 1); assert.equal(obs.stops, 0);
  assert.equal(obs.state.currentScene, 'Podcast'); assert.equal(studio.state().autoDirection?.enabled, true);
  assert.equal(studio.state().obs.recording, true); assert.equal(media.liveStarts, 0); assert.equal(media.state.liveStatus, 'idle');
  assert.ok(obs.calls.indexOf('record') < obs.calls.indexOf('intro'));
});

test('waiting for intro does not hold the command queue and duplicate starts cannot create a second recording', async t => {
  const { studio, obs, project, actor } = await fixture(t, true);
  await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
  await until(() => !!obs.playback, 'intro begins');
  const running = structuredClone(studio.state().launch);
  await assert.rejects(studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor)), { code: 'LAUNCH_ACTIVE' });
  assert.deepEqual(studio.state().launch, running, 'A duplicate hardware press preserves the effective running job');
  await assert.rejects(studio.serial(() => studio.control({ action: 'record.start', projectId: project.id }, actor)), { code: 'LAUNCH_ACTIVE' });
  await studio.serial(() => studio.control({ action: 'record.stop' }, actor));
  obs.playback!.status = 'stopped';
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(studio.state().launch?.status, 'cancelled'); assert.equal(obs.starts, 1); assert.equal(obs.stops, 1); assert.equal(studio.state().autoDirection?.enabled, false);
});

test('Windows local shutdown refuses an accepted launch before its first output starts', async t => {
  const { studio, obs, project, actor } = await fixture(t);
  await studio.serial(async () => {
    await studio.control({ action: 'production.start', projectId: project.id }, actor);
    assert.equal(obs.state.recording, false);
    assert.equal(obs.state.streaming, false);
    await assert.rejects(studio.prepareLocalShutdown(), { code: 'LOCAL_SHUTDOWN_BUSY' });
    assert.equal(studio.isDraining(), false);
  });
});

test('a stale stop confirmation cannot stop the next take after a one-touch launch', async t => {
  const { studio, obs, project, actor } = await fixture(t);
  await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
  await until(() => studio.state().launch?.status === 'completed', 'launch completes');
  const previousId = studio.state().activeTake!.id;
  await studio.serial(() => studio.control({ action: 'record.stop', expectedTakeId: previousId }, actor));
  await studio.serial(() => studio.control({ action: 'record.start', projectId: project.id }, actor));
  const nextId = studio.state().activeTake!.id; const stops = obs.stops;
  await assert.rejects(studio.serial(() => studio.control(controlInput({ action: 'record.stop', expectedTakeId: previousId }), actor)), { code: 'TAKE_CHANGED' });
  assert.equal(obs.stops, stops); assert.equal(obs.state.recording, true); assert.equal(studio.state().activeTake?.id, nextId);
  for (const expectedTakeId of [null, 42, '', ' ', 'x'.repeat(101)]) assert.throws(() => controlInput({ action: 'record.stop', expectedTakeId }));
});

test('manual media pause cancels subsequent automation without stealing the media from the user', async t => {
  const { studio, obs, project, actor } = await fixture(t, true);
  await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
  await until(() => !!obs.playback, 'intro begins');
  await studio.serial(() => studio.control({ action: 'media.pause' }, actor));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(studio.state().launch?.status, 'cancelled'); assert.equal(obs.playback?.status, 'paused');
  assert.equal(obs.mediaStops, 0); assert.equal(obs.state.recording, true); assert.equal(obs.state.currentScene, 'Nino · Médias');
});

test('opening the studio during a launch leaves its intro, recording and automatic sequence untouched', async t => {
  let opens = 0;
  const { studio, obs, project, actor } = await fixture(t, true, { studioOpener: async () => { opens++; } });
  await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
  await until(() => !!obs.playback, 'intro begins');
  const launch = structuredClone(studio.state().launch); const takeId = studio.state().activeTake!.id; const calls = obs.calls.length;
  await studio.serial(() => studio.control({ action: 'studio.open' }, actor));
  assert.equal(opens, 1); assert.deepEqual(studio.state().launch, launch); assert.equal(studio.state().activeTake!.id, takeId);
  assert.equal(obs.calls.length, calls); assert.equal(obs.state.recording, true); assert.equal(obs.playback!.status, 'playing');
  obs.playback!.status = 'stopped'; await until(() => studio.state().launch?.status === 'completed', 'original launch still completes');
});

test('explicit cancel restores only its own intro and leaves its confirmed recording running', async t => {
  const { studio, obs, project, actor } = await fixture(t, true);
  await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
  await until(() => !!obs.playback, 'intro begins');
  await studio.serial(() => studio.control({ action: 'production.cancel' }, actor));
  assert.equal(studio.state().launch?.status, 'cancelled'); assert.equal(obs.state.currentScene, 'Podcast'); assert.equal(obs.state.recording, true); assert.equal(obs.stops, 0);
});

test('cancelling never stops a media that replaced the launch intro', async t => {
  const { studio, obs, project, actor } = await fixture(t, true);
  await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
  await until(() => !!obs.playback, 'intro begins');
  obs.playback!.assetId = randomUUID();
  await studio.serial(() => studio.control({ action: 'production.cancel' }, actor));
  assert.equal(obs.mediaStops, 0); assert.equal(obs.playback!.status, 'playing'); assert.equal(obs.state.recording, true);
});

test('a missing automatic camera keeps the confirmed recording in manual mode with an explicit explanation', async t => {
  const { studio, obs, project, actor } = await fixture(t);
  await studio.serial(() => studio.control({ action: 'auto.configure', projectId: project.id, settings: { wideScene: 'Absent', thresholdDb: -38, dominanceDb: 6, confirmationMs: 600, minShotMs: 1000, silenceMs: 1500, overlapMs: 700 } }, actor));
  await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
  await until(() => studio.state().launch?.status === 'completed', 'manual launch completes');
  assert.match(studio.state().launch!.message, /Réalisation manuelle/);
  assert.equal(studio.state().autoDirection?.enabled, false); assert.equal(obs.state.recording, true);
});

test('a rejected start during an existing recording preserves the effective completed launch', async t => {
  const { studio, obs, project, actor } = await fixture(t);
  await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
  await until(() => studio.state().launch?.status === 'completed', 'launch completes while recording keeps running');
  const completed = structuredClone(studio.state().launch);
  await assert.rejects(studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor)), { code: 'PRODUCTION_ACTIVE' });
  assert.deepEqual(studio.state().launch, completed); assert.equal(obs.starts, 1); assert.equal(obs.state.recording, true);
});

test('an intro that never reports its end times out without stopping or replaying the recording', { timeout: 9000 }, async t => {
  const { studio, obs, project, actor } = await fixture(t, true);
  await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
  await until(() => !!obs.playback, 'intro begins');
  const deadline = Date.now() + 6500;
  while (studio.state().launch?.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(studio.state().launch?.status, 'failed');
  assert.match(studio.state().launch!.message, /fin de l’introduction/);
  assert.equal(obs.starts, 1); assert.equal(obs.stops, 0); assert.equal(obs.state.recording, true);
});

test('a missing intro file fails before any output starts', async t => {
  const { studio, store, obs, media, project, actor } = await fixture(t, true);
  const assetId = store.projectMedia()[project.id][0].assetId;
  await rm(path.join(store.dataDir, 'library', `${assetId}.mp4`));
  await assert.rejects(studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor)), { code: 'MEDIA_FILE_NOT_FOUND' });
  assert.equal(obs.starts, 0); assert.equal(obs.previewStarts, 0); assert.equal(media.liveStarts, 0);
});

test('a restart preserves the selected project and cancels a pending launch without resuming any command', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nino-launch-restart-'));
  const store = new Store(directory); const obs = new ObsFixture();
  let studio = new Studio(store, obs, new MediaFixture(), { autoIntervalMs: 0 });
  const project = studio.createProject({ title: 'Projet conservé', format: 'podcast' });
  await studio.serial(() => studio.selectStreamDeckProject(project.id));
  await studio.close();
  // Represents an abrupt process loss, before the new process can know whether
  // an external output ever started. No former job may be automatically resumed.
  const saved = new Store(directory);
  saved.setSetting('productionLaunch', { id: 'prior-launch', projectId: project.id, takeId: null, status: 'running', step: 'preparing', includeLive: false, message: 'Préparation', updatedAt: new Date().toISOString() });
  saved.close();
  studio = new Studio(new Store(directory), obs, new MediaFixture(), { autoIntervalMs: 0 });
  t.after(async () => { await studio.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(studio.state().streamDeck?.projectId, project.id);
  assert.equal(studio.state().launch?.status, 'cancelled'); assert.match(studio.state().launch!.message, /redémarré/);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(obs.starts, 0); assert.equal(obs.previewStarts, 0);
});

test('external stop, pause, changed recording directory or manual OBS scene cannot continue the launch', async t => {
  for (const change of ['stop', 'pause', 'directory', 'scene'] as const) await t.test(change, async st => {
    const { studio, obs, project, actor } = await fixture(st, true);
    await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
    await until(() => !!obs.playback, 'intro begins');
    if (change === 'stop') obs.state.recording = false;
    if (change === 'pause') obs.state.paused = true;
    if (change === 'directory') obs.state.recordingDirectory = path.join(os.tmpdir(), 'external');
    if (change === 'scene') obs.state.currentScene = 'Caméra';
    await until(() => studio.state().launch?.status === 'cancelled', 'external intervention cancels');
    assert.equal(obs.starts, 1); assert.equal(studio.state().autoDirection?.enabled, false);
    if (change === 'scene') assert.equal(obs.state.currentScene, 'Caméra', 'A manual scene stays selected');
  });
});

test('OBS failures retain an existing take and revocation cancels waiting work', async t => {
  for (const change of ['failure', 'revoke'] as const) await t.test(change, async st => {
    const { studio, store, obs, project, actor, auth } = await fixture(st, true);
    await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
    await until(() => !!obs.playback, 'intro begins');
    if (change === 'failure') { obs.playback!.status = 'unknown'; obs.playback!.error = 'Source perdue'; }
    else store.revoke(auth.device.id);
    await until(() => studio.state().launch?.status !== 'running', 'launch stops advancing');
    assert.equal(studio.state().launch?.status, change === 'failure' ? 'failed' : 'cancelled');
    assert.equal(obs.state.recording, true); assert.equal(obs.stops, 0);
  });
});

test('a missing or ambiguous intro blocks before recording and selection is persistent, idle-only and idempotent', async t => {
  const { studio, store, obs, project, actor } = await fixture(t, true);
  const other = studio.createProject({ title: 'Autre', format: 'podcast', participants: project.participants });
  await studio.serial(() => studio.selectStreamDeckProject(project.id));
  assert.equal(store.setting('streamDeckProjectId'), project.id);
  const links = store.projectMedia()[project.id];
  store.put('projectMedia', { id: project.id, links: [...links, { ...links[0], assetId: randomUUID() }] });
  await assert.rejects(studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor)), { code: 'LAUNCH_INTRO_AMBIGUOUS' });
  assert.equal(studio.state().launch?.status, 'failed'); assert.match(studio.state().launch!.message, /une seule vidéo/);
  assert.equal(obs.starts, 0);
  store.put('projectMedia', { id: project.id, links });
  await studio.serial(() => studio.control({ action: 'production.start', projectId: project.id }, actor));
  await until(() => !!obs.playback, 'intro begins');
  await assert.rejects(studio.serial(() => studio.selectStreamDeckProject(other.id)), { code: 'PRODUCTION_ACTIVE' });
  assert.equal((await studio.serial(() => studio.selectStreamDeckProject(project.id))).streamDeck?.projectId, project.id);
});

test('API selection requires operator auth; retrying a launch request is idempotent without enabling real Companion', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nino-launch-api-')); const obs = new ObsFixture(); const media = new MediaFixture();
  const app = await buildApp({ dataDir, obs, media });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal((await app.inject({ method: 'POST', url: '/api/streamdeck/select', payload: { projectId: 'x' } })).statusCode, 401);
  const auth = (await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost' } })).json(); const headers = { authorization: `Bearer ${auth.token}` };
  const pair = (await app.inject({ method: 'POST', url: '/api/pairing', headers, payload: { role: 'viewer', kind: 'ipad' } })).json();
  const viewer = (await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: pair.code, name: 'iPad', kind: 'ipad' } })).json();
  assert.equal((await app.inject({ method: 'POST', url: '/api/streamdeck/select', headers: { authorization: `Bearer ${viewer.token}` }, payload: { projectId: 'x' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/control', headers: { authorization: `Bearer ${viewer.token}` }, payload: { action: 'production.start', projectId: 'x' } })).statusCode, 403);
  await app.inject({ method: 'PATCH', url: '/api/room', headers, payload: { recordingRoot: path.join(dataDir, 'recordings') } });
  const project = (await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { title: 'Test API', format: 'podcast', participants: [{ id: 'p', name: 'Alice', micInput: 'Micro', sceneName: 'Caméra' }] } })).json();
  const selected = await app.inject({ method: 'POST', url: '/api/streamdeck/select', headers, payload: { projectId: project.id } });
  assert.equal(selected.statusCode, 200); assert.equal(selected.json().streamDeck.projectId, project.id); assert.equal(selected.json().streamDeck.companionConnected, false);
  const payload = { action: 'production.start', projectId: project.id, requestId: 'same-command' };
  const first = await app.inject({ method: 'POST', url: '/api/control', headers, payload }); assert.equal(first.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/control', headers, payload })).statusCode, 200);
  await until(() => obs.starts === 1, 'only one confirmed recording');
  const after = (await app.inject({ method: 'GET', url: '/api/state', headers })).json(); assert.equal(after.media.liveStatus, 'idle'); assert.equal(media.liveStarts, 0);
});
