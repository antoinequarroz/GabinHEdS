import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AudioFrame, AutoDirectionSettings, MediaPlayback, ObsState, Participant } from '@gabin/shared';
import { AutoDirection } from '../src/auto-direction.js';
import { emptyObsState, type ObsEvent, type ObsGateway } from '../src/obs.js';
import { controlInput } from '../src/validation.js';
import { Store } from '../src/store.js';
import { Studio } from '../src/studio.js';

const participants: Participant[] = [
  { id: 'alice', name: 'Alice', micInput: 'Micro Alice', sceneName: 'Caméra Alice' },
  { id: 'bob', name: 'Bob', micInput: 'Micro Bob', sceneName: 'Caméra Bob' },
];
const settings: AutoDirectionSettings = { wideScene: 'Plan large', thresholdDb: -38, dominanceDb: 6, confirmationMs: 600, minShotMs: 1000, silenceMs: 1500, overlapMs: 700 };
const state = (): ObsState => ({ ...emptyObsState(), connected: true, scenes: ['Plan large', 'Caméra Alice', 'Caméra Bob', 'Nino · Médias'], currentScene: 'Plan large',
  inputs: participants.map(p => ({ name: p.micInput!, kind: 'audio', muted: false, volumeDb: 0 })) });
const frame = (at: number, alice = -20, bob = -65): AudioFrame => ({ capturedAt: new Date(at).toISOString(), inputs: [
  { inputName: 'Micro Alice', rmsDb: alice, peakDb: alice + 2 }, { inputName: 'Micro Bob', rmsDb: bob, peakDb: bob + 2 },
] });

test('speech confirmation uses distinct fresh frames and respects minimum shot time', () => {
  const obs = state();
  const engine = new AutoDirection(participants, settings, obs.currentScene, 0);
  assert.equal(engine.observe(frame(100), obs, 100).decision, null);
  assert.equal(engine.observe(frame(800), obs, 800).decision, null, 'confirmed speech still respects the current shot');
  assert.deepEqual(engine.observe(frame(1000), obs, 1000).decision, { sceneName: 'Caméra Alice', reason: 'speaker', participantId: 'alice' });
  obs.currentScene = 'Caméra Alice'; engine.confirmScene(obs.currentScene, 1000);
  assert.equal(engine.observe(frame(1100, -65, -18), obs, 1100).decision, null);
  assert.equal(engine.observe(frame(1900, -65, -18), obs, 1900).decision, null);
  assert.equal(engine.observe(frame(2100, -65, -18), obs, 2100).decision?.sceneName, 'Caméra Bob');
});

test('one old/cached frame and out-of-order frames never establish sustained speech', () => {
  const obs = state(); const engine = new AutoDirection(participants, settings, obs.currentScene, 0);
  assert.equal(engine.observe(frame(500), obs, 500).decision, null);
  assert.equal(engine.observe(frame(500), obs, 1300).decision, null);
  assert.equal(engine.observe(frame(400), obs, 1300).decision, null);
  assert.equal(engine.observe(frame(500), obs, 2100).status, 'waiting');
  assert.equal(engine.observe(frame(2200), obs, 2200).decision, null, 'loss of audio resets the confirmation');
});

test('fresh audio after an unobserved gap starts a new speech confirmation', () => {
  const obs = state(); const engine = new AutoDirection(participants, settings, obs.currentScene, 0);
  engine.observe(frame(1000), obs, 1000);
  assert.equal(engine.observe(frame(10000), obs, 10000).decision, null, 'a blocked watchdog cannot turn a gap into sustained speech');
  assert.equal(engine.observe(frame(10700), obs, 10700).decision?.sceneName, 'Caméra Alice');
});

test('close competing voices go wide, while microphone bleed stays on the dominant speaker', () => {
  const obs = state(); obs.currentScene = 'Caméra Alice';
  const engine = new AutoDirection(participants, settings, obs.currentScene, 0);
  engine.observe(frame(1000, -20, -23), obs, 1000);
  assert.deepEqual(engine.observe(frame(1800, -20, -23), obs, 1800).decision, { sceneName: 'Plan large', reason: 'overlap', participantId: null });
  engine.confirmScene('Plan large', 1800); obs.currentScene = 'Plan large';
  engine.observe(frame(2200, -18, -30), obs, 2200);
  assert.equal(engine.observe(frame(3000, -18, -30), obs, 3000).decision?.participantId, 'alice');
});

test('silence has its own sustained hold and missing/muted/invalid audio cannot trigger a fallback cut', () => {
  const obs = state(); obs.currentScene = 'Caméra Alice'; const engine = new AutoDirection(participants, settings, obs.currentScene, 0);
  engine.observe(frame(1000, -65, -65), obs, 1000);
  assert.equal(engine.observe(frame(2000, -65, -65), obs, 2000).decision, null);
  assert.equal(engine.observe(frame(2500, -65, -65), obs, 2500).decision?.reason, 'silence');
  const missing = frame(2600); missing.inputs.pop();
  assert.equal(engine.observe(missing, obs, 2600).status, 'waiting');
  obs.inputs[1].muted = true;
  assert.equal(engine.observe(frame(2700), obs, 2700).decision, null);
  assert.equal(engine.observe(frame(2700), obs, 2700).status, 'waiting');
  obs.inputs[1].muted = false;
  const invalid = frame(2800); invalid.inputs[1].rmsDb = NaN;
  assert.equal(engine.observe(invalid, obs, 2800).status, 'waiting');
  assert.equal(engine.observe(frame(5000), obs, 2800).status, 'waiting', 'future timestamp is not trusted');
});

test('automatic settings reject unsafe/unknown values at the shared API boundary', () => {
  assert.deepEqual(controlInput({ action: 'auto.configure', projectId: 'project', settings }), { action: 'auto.configure', projectId: 'project', settings, requestId: undefined });
  for (const invalid of [{ thresholdDb: -100 }, { minShotMs: 1 }, { confirmationMs: NaN }, { wideScene: '' }, { arbitrary: 1 }, { silenceMs: '5000' }]) {
    assert.throws(() => controlInput({ action: 'auto.configure', projectId: 'project', settings: { ...settings, ...invalid } }), { statusCode: 400 });
  }
});

class Gateway implements ObsGateway {
  state = state();
  cuts: string[] = [];
  recordingStarts = 0;
  streamingStarts = 0;
  playback: MediaPlayback | null = null;
  private listeners = new Set<(event: ObsEvent) => void>();
  getState() { return structuredClone(this.state); }
  subscribe(listener: (event: ObsEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: ObsEvent) { for (const listener of this.listeners) listener(event); }
  async connect() { this.state.connected = true; return this.refresh(); }
  async disconnect() { this.state.connected = false; this.emit({ type: 'disconnected' }); }
  async refresh() { this.emit({ type: 'state', state: this.getState() }); return this.getState(); }
  async sceneThumbnail(sceneName: string) { return { sceneName, imageData: null, capturedAt: null, available: false }; }
  async setScene(sceneName: string) { this.cuts.push(sceneName); this.state.currentScene = sceneName; }
  async setInputMute(name: string, muted: boolean) { this.state.inputs.find(input => input.name === name)!.muted = muted; }
  async setRecordDirectory(directory: string) { this.state.recordingDirectory = directory; }
  async startRecord() { this.recordingStarts++; this.state.recording = true; this.state.timecode = '00:00:01.000'; }
  async stopRecord() { this.state.recording = false; return { outputPath: path.join(this.state.recordingDirectory!, 'video.mkv') }; }
  async pauseRecord() { this.state.paused = true; }
  async resumeRecord() { this.state.paused = false; }
  async configureLocalFeed() {}
  async startStream() { this.streamingStarts++; this.state.streaming = true; }
  async stopStream() { this.state.streaming = false; }
  getMediaPlayback() { return this.playback; }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nino-auto-direction-'));
  const store = new Store(path.join(directory, 'db'));
  const obs = new Gateway();
  let now = Date.now();
  const studio = new Studio(store, obs, undefined, { now: () => now, autoIntervalMs: 0 });
  studio.updateRoom({ recordingRoot: path.join(directory, 'recordings'), defaultScenes: { podcast: 'Plan large', roundtable: 'Plan large', slides: 'Plan large' } });
  const project = studio.createProject({ title: 'Table ronde', format: 'roundtable', participants: structuredClone(participants) });
  const device = store.createDevice('iPad de test', 'ipad', 'operator').device;
  const actor = { deviceId: device.id };
  const control = (command: Parameters<Studio['control']>[0]) => studio.serial(() => studio.control(command, actor));
  const tick = async (elapsed: number, alice = -20, bob = -65) => {
    now += elapsed;
    obs.emit({ type: 'audio', frame: frame(now, alice, bob) });
    await studio.serial(() => studio.tickAutoDirection());
    await studio.serial(() => undefined);
  };
  await control({ action: 'auto.configure', projectId: project.id, settings });
  t.after(async () => { await studio.close(); await rm(directory, { recursive: true, force: true }); });
  return { studio, store, obs, project, device, actor, control, tick, advance: (elapsed: number) => { now += elapsed; } };
}

test('automatic control is authenticated, never starts outputs, journals only confirmed OBS changes', async t => {
  const { studio, obs, project, control, tick, store } = await fixture(t);
  await assert.rejects(studio.serial(() => studio.control({ action: 'auto.start', projectId: project.id })), { code: 'AUTO_AUTH_REQUIRED' });
  await control({ action: 'auto.start', projectId: project.id });
  await tick(1000); await tick(700);
  assert.equal(studio.state().obs.currentScene, 'Caméra Alice');
  assert.equal(obs.recordingStarts, 0); assert.equal(obs.streamingStarts, 0);
  const cuts = store.sceneChanges();
  assert.equal(cuts.length, 1); assert.equal(cuts[0].reason, 'speaker'); assert.equal(cuts[0].participantId, 'alice');
  assert.equal(cuts[0].takeId, null); assert.equal(cuts[0].offsetMs, null);
  assert.equal(studio.state().autoDirection?.enabled, true);
  await control({ action: 'auto.stop' });
  await tick(2000, -65, -20);
  assert.equal(obs.cuts.length, 1, 'manual mode cannot be reactivated by incoming audio');
});

test('manual PC/iPad/Deck controls and external OBS switches suspend automatic direction without fighting', async t => {
  const { studio, obs, project, control, tick } = await fixture(t);
  await control({ action: 'auto.start', projectId: project.id }); await tick(1000); await tick(700);
  await control({ action: 'scene.set', sceneName: 'Plan large' });
  assert.equal(studio.state().autoDirection?.status, 'suspended');
  await tick(2000); await tick(700);
  assert.equal(obs.state.currentScene, 'Plan large');
  await control({ action: 'auto.start', projectId: project.id });
  obs.state.currentScene = 'Caméra Bob'; await obs.refresh(); await studio.serial(() => undefined);
  assert.equal(studio.state().autoDirection?.enabled, false);
  await tick(2000); await tick(700);
  assert.equal(obs.state.currentScene, 'Caméra Bob');
});

test('stale audio and cut microphones wait safely; revoked or disconnected controllers require explicit resumption', async t => {
  const { studio, obs, project, device, control, tick, advance, store } = await fixture(t);
  await control({ action: 'auto.start', projectId: project.id });
  await tick(1000); advance(1600); await studio.serial(() => studio.tickAutoDirection());
  assert.equal(studio.state().autoDirection?.status, 'waiting'); assert.equal(obs.cuts.length, 0);
  obs.state.inputs[1].muted = true; await tick(1000); await tick(700);
  assert.equal(studio.state().autoDirection?.status, 'waiting'); assert.equal(obs.cuts.length, 0);
  obs.state.inputs[1].muted = false;
  store.revoke(device.id); await tick(1000);
  assert.equal(studio.state().autoDirection?.status, 'suspended'); assert.equal(obs.cuts.length, 0);
  const owner = store.createDevice('PC', 'pc', 'operator').device;
  await studio.serial(() => studio.control({ action: 'auto.start', projectId: project.id }, { deviceId: owner.id }));
  await obs.disconnect(); await studio.serial(() => undefined);
  assert.equal(studio.state().autoDirection?.status, 'suspended');
  await obs.connect(); await tick(1000); await tick(700);
  assert.equal(obs.cuts.length, 0, 'reconnection never rearms autonomous control');
});

test('unconfirmed OBS scene acknowledgement does not journal a cut or silently retry', async t => {
  const { studio, obs, project, control, tick, store } = await fixture(t);
  await control({ action: 'auto.start', projectId: project.id });
  obs.setScene = async scene => { obs.cuts.push(scene); obs.state.connected = false; };
  await tick(1000); await tick(700);
  assert.equal(studio.state().autoDirection?.status, 'error');
  assert.equal(store.sceneChanges().length, 0); assert.equal(obs.cuts.length, 1);
  await tick(5000); assert.equal(obs.cuts.length, 1);
});

test('revocation during OBS acknowledgement preserves the real cut without reviving automatic mode', async t => {
  const { studio, obs, project, device, control, tick, store } = await fixture(t);
  await control({ action: 'auto.start', projectId: project.id });
  obs.setScene = async scene => {
    obs.cuts.push(scene); obs.state.currentScene = scene;
    store.revoke(device.id); studio.revokeAutoDevice(device.id);
  };
  await tick(1000); await tick(700);
  assert.equal(obs.state.currentScene, 'Caméra Alice');
  assert.equal(store.sceneChanges().at(-1)?.sceneName, 'Caméra Alice');
  assert.equal(studio.state().autoDirection?.enabled, false);
  assert.equal(studio.state().autoDirection?.status, 'suspended');
  assert.match(studio.state().autoDirection!.message, /plus autorisé/);
});

test('fullscreen media protect the program and auto cannot bind to shared microphones or a foreign take', async t => {
  const { studio, obs, project, control } = await fixture(t);
  obs.playback = { assetId: 'intro', mode: 'fullscreen', sceneName: 'Nino · Médias', status: 'paused', error: null };
  obs.state.currentScene = 'Nino · Médias';
  await assert.rejects(control({ action: 'auto.start', projectId: project.id }), { code: 'AUTO_MEDIA_ACTIVE' });
  obs.playback = null; obs.state.currentScene = 'Plan large';
  studio.updateProject(project.id, { participants: [participants[0], { ...participants[1], micInput: participants[0].micInput }] });
  await assert.rejects(control({ action: 'auto.start', projectId: project.id }), { code: 'AUTO_DISTINCT_MICS' });
  studio.updateProject(project.id, { participants });
  obs.state.recording = true;
  await assert.rejects(control({ action: 'auto.start', projectId: project.id }), { code: 'PROJECT_CONFLICT' });
});

test('per-take journal uses real OBS recording time and paused cuts have no invented offsets', async t => {
  const { studio, obs, project, store, control, tick } = await fixture(t);
  await control({ action: 'record.start', projectId: project.id });
  const take = studio.state().activeTake!;
  assert.equal(store.sceneChanges()[0].offsetMs, 0); assert.equal(store.sceneChanges()[0].reason, 'start');
  await control({ action: 'auto.start', projectId: project.id });
  obs.state.timecode = '00:00:09.500';
  await tick(1000); await tick(700);
  assert.equal(store.sceneChanges().at(-1)?.takeId, take.id); assert.equal(store.sceneChanges().at(-1)?.offsetMs, 9500);
  await control({ action: 'record.pause' });
  await control({ action: 'scene.set', sceneName: 'Caméra Bob' });
  assert.equal(store.sceneChanges().at(-1)?.offsetMs, null);
  await control({ action: 'record.resume' });
  assert.equal(store.sceneChanges().at(-1)?.sceneName, 'Caméra Bob');
  assert.equal(store.sceneChanges().at(-1)?.previousSceneName, 'Caméra Alice');
  assert.equal(store.sceneChanges().at(-1)?.offsetMs, 9500, 'resumed image is anchored to the real unpaused file time');
  obs.state.timecode = '00:00:10.000';
  await control({ action: 'scene.set', sceneName: 'Plan large' });
  assert.equal(store.sceneChanges().at(-1)?.offsetMs, 10000, 'wall-clock pause time was never added');
});

test('a queued manual choice wins after an automatic cut and no pending tick restarts auto', async t => {
  const { studio, obs, project, control, tick } = await fixture(t);
  await control({ action: 'auto.start', projectId: project.id }); await tick(1000);
  const automatic = tick(700);
  const manual = control({ action: 'scene.set', sceneName: 'Caméra Bob' });
  await Promise.all([automatic, manual]);
  await tick(2000); await tick(700);
  assert.equal(studio.state().autoDirection?.status, 'suspended'); assert.equal(obs.state.currentScene, 'Caméra Bob');
  assert.deepEqual(obs.cuts, ['Caméra Alice', 'Caméra Bob']);
});

test('resuming directly in OBS anchors the image changed during a pause to actual file time', async t => {
  const { studio, obs, project, store, control } = await fixture(t);
  await control({ action: 'record.start', projectId: project.id });
  obs.state.timecode = '00:00:09.500';
  await control({ action: 'record.pause' });
  obs.state.currentScene = 'Caméra Bob';
  obs.emit({ type: 'state', state: obs.getState() });
  await studio.serial(() => undefined);
  assert.equal(store.sceneChanges().at(-1)?.offsetMs, null);
  obs.state.paused = false;
  obs.emit({ type: 'state', state: obs.getState() });
  await studio.serial(() => undefined);
  assert.equal(store.sceneChanges().at(-1)?.sceneName, 'Caméra Bob');
  assert.equal(store.sceneChanges().at(-1)?.previousSceneName, 'Plan large');
  assert.equal(store.sceneChanges().at(-1)?.offsetMs, 9500);
});

test('saved configuration survives restart, while activation and controller lease do not', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nino-auto-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory); const obs = new Gateway();
  const studio = new Studio(store, obs, undefined, { autoIntervalMs: 0 });
  const project = studio.createProject({ title: 'Podcast', format: 'podcast', participants });
  const device = store.createDevice('PC', 'pc', 'operator').device;
  await studio.serial(() => studio.control({ action: 'auto.configure', projectId: project.id, settings }));
  await studio.serial(() => studio.control({ action: 'auto.start', projectId: project.id }, { deviceId: device.id }));
  await studio.close();
  const restarted = new Studio(new Store(directory), new Gateway(), undefined, { autoIntervalMs: 0 });
  assert.equal(restarted.state().autoDirection?.enabled, false); assert.equal(restarted.state().autoDirection?.status, 'off');
  assert.deepEqual(restarted.state().autoDirectionSettings?.[project.id], settings);
  await restarted.close();
});
