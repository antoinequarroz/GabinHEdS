import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MediaState, ObsState, Project, Take } from '@gabin/shared';
import { emptyObsState, type ObsEvent, type ObsGateway } from '../src/obs.js';
import { Store } from '../src/store.js';
import { Studio } from '../src/studio.js';
import { emptyMediaState, type MediaGateway, type PrivateLiveDestination } from '../src/media.js';

/** A deterministic gateway fixture; real WebSocket protocol is tested separately. */
class Gateway implements ObsGateway {
  private state: ObsState = { ...emptyObsState(), connected: true, scenes: ['Podcast'], currentScene: 'Podcast',
    inputs: [{ name: 'Micro 1', kind: 'audio', muted: false, volumeDb: 0 }] };
  private listeners = new Set<(event: ObsEvent) => void>();
  stops = 0;
  starts = 0;
  streamStops = 0;
  sceneChanges = 0;
  getState() { return structuredClone(this.state); }
  emit(event: ObsEvent) { for (const listener of this.listeners) listener(event); }
  subscribe(listener: (event: ObsEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async connect() { this.state.connected = true; return this.refresh(); }
  async disconnect() { this.state.connected = false; this.emit({ type: 'disconnected' }); }
  async refresh() { this.emit({ type: 'state', state: this.getState() }); return this.getState(); }
  async sceneThumbnail(sceneName: string) { return { sceneName, imageData: null, capturedAt: null, available: false }; }
  async setScene(sceneName: string) { this.sceneChanges++; this.state.currentScene = sceneName; }
  async setInputMute(name: string, muted: boolean) { this.state.inputs.find(input => input.name === name)!.muted = muted; }
  async setRecordDirectory(directory: string) { this.state.recordingDirectory = directory; }
  async startRecord() { this.starts++; this.state.recording = true; this.state.timecode = '00:00:01.000'; this.emit({ type: 'state', state: this.getState() }); }
  async pauseRecord() { this.state.paused = true; this.emit({ type: 'state', state: this.getState() }); }
  async resumeRecord() { this.state.paused = false; this.emit({ type: 'state', state: this.getState() }); }
  async configureLocalFeed() {}
  async startStream() { this.state.streaming = true; this.emit({ type: 'state', state: this.getState() }); }
  async stopStream() { this.streamStops++; this.state.streaming = false; this.emit({ type: 'state', state: this.getState() }); }
  async stopRecord() { this.stops++; return this.externalStop(); }
  externalStop() {
    const outputPath = path.join(this.state.recordingDirectory!, 'video.mkv');
    this.state.recording = false;
    this.state.paused = false;
    // Deliberately publish an inactive snapshot BEFORE the final path event.
    this.emit({ type: 'state', state: this.getState() });
    this.emit({ type: 'recordStopped', outputPath, durationMs: 1000 });
    return { outputPath };
  }
}

class MediaFixture implements MediaGateway {
  private state: MediaState = { ...emptyMediaState(), available: true };
  private listeners = new Set<(state: MediaState) => void>();
  liveStarts = 0;
  constructor(private obs: Gateway) {}
  getState() { return structuredClone(this.state); }
  private changed() { for (const listener of this.listeners) listener(this.getState()); }
  async refresh() { this.state.previewReady = this.obs.getState().streaming; return this.getState(); }
  ingestSettings() { return { server: 'rtmp://127.0.0.1:1935/gabin', key: 'program' }; }
  async startLive(destination: PrivateLiveDestination) {
    this.liveStarts++; this.state.liveStatus = 'starting'; this.state.liveDestination = destination.name; this.changed();
    this.state.liveStatus = 'live'; this.changed();
  }
  async stopLive() { this.state.liveStatus = 'idle'; this.changed(); }
  async hlsResource() { return new Response('test'); }
  subscribe(listener: (state: MediaState) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close() {}
}

async function fixture(t: TestContext, withMedia = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gabin-recording-'));
  const store = new Store(path.join(directory, 'db'));
  const obs = new Gateway();
  const media = withMedia ? new MediaFixture(obs) : undefined;
  const studio = new Studio(store, obs, media);
  studio.updateRoom({ recordingRoot: path.join(directory, 'recordings') });
  const project: Project = studio.createProject({ title: 'Podcast de test', format: 'podcast',
    participants: [{ id: 'participant-1', name: 'Camille', micInput: 'Micro 1', sceneName: null }] });
  t.after(async () => { await studio.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, studio, obs, media, project };
}

test('queued pre-start snapshots never interrupt a confirmed new take', async (t) => {
  const { studio, obs, project } = await fixture(t);
  await studio.serial(() => studio.control({ action: 'record.start', projectId: project.id }));
  await studio.serial(() => undefined);
  assert.equal(studio.state().activeTake?.status, 'recording');
  assert.equal(obs.starts, 1);
  await studio.serial(() => studio.control({ action: 'record.pause' }));
  await studio.serial(() => studio.control({ action: 'record.resume' }));
  await studio.serial(() => undefined);
  assert.equal(studio.state().activeTake?.status, 'recording');
  assert.equal(studio.state().obs.paused, false);
});

test('an accepted recording without output confirmation stays uncertain and cannot be retried', { timeout: 25_000 }, async (t) => {
  const { studio, obs, project } = await fixture(t);
  obs.startRecord = async () => { obs.starts++; }; // ACK only; the output never becomes active.
  await assert.rejects(studio.serial(() => studio.control({ action: 'record.start', projectId: project.id })),
    { code: 'OBS_CONFIRMATION_LOST' });
  assert.equal(studio.state().activeTake, null);
  assert.equal(studio.state().takes.length, 0);
  assert.ok(studio.store.setting('pendingTake'));
  await assert.rejects(studio.serial(() => studio.control({ action: 'record.start', projectId: project.id })),
    { code: 'PREPARATION_BLOCKED' });
  assert.equal(obs.starts, 1, 'An output that might start late is never started a second time');
  await studio.serial(() => studio.connect());
  assert.equal(studio.store.setting('pendingTake'), null, 'An explicit OBS check confirms inactivity and clears the uncertainty');
});

test('a local feed handshake beyond five seconds confirms without replaying the start', { timeout: 20_000 }, async (t) => {
  const { studio, obs } = await fixture(t, true);
  const startStream = obs.startStream.bind(obs);
  let starts = 0;
  let timer: ReturnType<typeof setTimeout>;
  obs.startStream = async () => {
    starts++;
    timer = setTimeout(() => { void startStream(); }, 6000);
  };
  t.after(() => clearTimeout(timer!));
  const confirmed = await studio.serial(() => studio.control({ action: 'preview.start' }));
  assert.equal(confirmed.obs.streaming, true);
  assert.equal(starts, 1);
});

test('early pause, resume and stop ACKs wait for the actual output transition', async (t) => {
  const { studio, obs, project } = await fixture(t, true);
  await studio.serial(() => studio.control({ action: 'record.start', projectId: project.id }));
  await studio.serial(() => studio.control({ action: 'preview.start' }));
  const takeId = studio.state().activeTake!.id;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const later = (transition: () => Promise<unknown>) => { timers.push(setTimeout(() => { void transition(); }, 250)); };
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const pause = obs.pauseRecord.bind(obs);
  const resume = obs.resumeRecord.bind(obs);
  const stopStream = obs.stopStream.bind(obs);
  const stopRecord = obs.stopRecord.bind(obs);
  obs.pauseRecord = async () => { later(pause); };
  obs.resumeRecord = async () => { later(resume); };
  obs.stopStream = async () => { later(stopStream); };
  obs.stopRecord = async () => {
    later(stopRecord);
    return { outputPath: path.join(obs.getState().recordingDirectory!, 'video.mkv') };
  };

  const pausing = studio.serial(() => studio.control({ action: 'record.pause' }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(studio.state().obs.paused, false, 'An ACK does not invent a pause');
  assert.equal((await pausing).obs.paused, true);
  const resuming = studio.serial(() => studio.control({ action: 'record.resume' }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(studio.state().obs.paused, true, 'The paused state lasts until OBS confirms resume');
  assert.equal((await resuming).obs.paused, false);

  const stoppingPreview = studio.serial(() => studio.control({ action: 'preview.stop' }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(studio.state().obs.streaming, true, 'The feed remains active while OBS is stopping it');
  assert.equal((await stoppingPreview).obs.streaming, false);
  assert.equal(studio.state().obs.recording, true);
  const stoppingRecord = studio.serial(() => studio.control({ action: 'record.stop' }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(studio.state().obs.recording, true);
  assert.equal(studio.state().takes.find(take => take.id === takeId)?.status, 'recording');
  assert.equal((await stoppingRecord).takes.find(take => take.id === takeId)?.status, 'completed');
  assert.equal(obs.stops, 1, 'Stopping is confirmed without replaying StopRecord');
  assert.equal(obs.streamStops, 1, 'Stopping is confirmed without replaying StopStream');
});

test('live, preview and recording stop independently; stopping preview cannot cut a live', async (t) => {
  const { studio, obs, media, project } = await fixture(t, true);
  const startingProjects: Array<string | null> = [];
  studio.subscribe(state => { if (state.media.liveStatus === 'starting') startingProjects.push(state.liveProjectId); });
  studio.updateRoom({ liveDestination: { name: 'Live de test', server: 'rtmp://example.com/live', key: 'private-key' } });
  await studio.serial(() => studio.control({ action: 'record.start', projectId: project.id }));
  await studio.serial(() => studio.control({ action: 'preview.start' }));
  await studio.serial(() => studio.control({ action: 'stream.start', projectId: project.id }));
  assert.equal(studio.state().media.liveStatus, 'live');
  assert.equal(studio.state().liveProjectId, project.id);
  assert.deepEqual(startingProjects, [project.id]);
  assert.equal(studio.state().obs.streaming, true);
  assert.equal(studio.state().obs.recording, true);
  await studio.serial(() => studio.control({ action: 'record.pause' }));
  assert.equal(studio.state().media.liveStatus, 'live');
  await assert.rejects(studio.serial(() => studio.control({ action: 'preview.stop' })), /direct/);
  assert.equal(obs.streamStops, 0);
  await studio.serial(() => studio.control({ action: 'stream.stop' }));
  assert.equal(studio.state().liveProjectId, null);
  assert.equal(studio.state().obs.recording, true);
  assert.equal(studio.state().obs.streaming, true);
  assert.equal(obs.stops, 0);
  await studio.serial(() => studio.control({ action: 'stream.start', projectId: project.id }));
  await studio.serial(() => studio.control({ action: 'record.stop' }));
  assert.equal(studio.state().media.liveStatus, 'live');
  assert.equal(studio.state().obs.streaming, true);
  await studio.serial(() => studio.control({ action: 'stream.stop' }));
  await studio.serial(() => studio.control({ action: 'preview.stop' }));
  assert.equal(studio.state().obs.streaming, false);
  assert.equal(obs.streamStops, 1);
  assert.equal(media!.liveStarts, 2);
});

test('a refused relay start clears its project binding without stopping recording', async (t) => {
  const { studio, obs, media, project } = await fixture(t, true);
  studio.updateRoom({ liveDestination: { name: 'Live de test', server: 'rtmp://example.com/live', key: 'private-key' } });
  media!.startLive = async () => { throw new Error('Relay refused'); };
  await assert.rejects(studio.serial(() => studio.control({ action: 'stream.start', projectId: project.id })), /relais/);
  assert.equal(studio.state().liveProjectId, null);
  assert.equal(obs.stops, 0);
  assert.equal(studio.updateProject(project.id, { title: 'Nom corrigé' }).title, 'Nom corrigé');
});

test('live relay remains manually stoppable after losing OBS connection', async (t) => {
  const { studio, obs, project } = await fixture(t, true);
  studio.updateRoom({ liveDestination: { name: 'Live de test', server: 'rtmp://example.com/live', key: 'private-key' } });
  await studio.serial(() => studio.control({ action: 'stream.start', projectId: project.id }));
  await obs.disconnect();
  await studio.serial(() => undefined);
  assert.equal(studio.state().media.liveStatus, 'live');
  await studio.serial(() => studio.control({ action: 'stream.stop' }));
  assert.equal(studio.state().media.liveStatus, 'idle');
  assert.equal(obs.stops, 0);
  assert.equal(obs.streamStops, 0);
});

test('recording during a live is bound to its project and preserves the current programme', async (t) => {
  const { studio, obs, project } = await fixture(t, true);
  studio.updateRoom({ liveDestination: { name: 'Live de test', server: 'rtmp://example.com/live', key: 'private-key' } });
  const other = studio.createProject({ title: 'Autre production', format: 'podcast', participants: project.participants });
  await studio.serial(() => studio.control({ action: 'stream.start', projectId: project.id }));
  await assert.rejects(studio.serial(() => studio.control({ action: 'record.start', projectId: other.id })), /autre projet/);
  assert.equal(obs.starts, 0);
  assert.equal((await studio.preparation(other.id)).canStart, false);
  const sceneChanges = obs.sceneChanges;
  await studio.serial(() => studio.control({ action: 'record.start', projectId: project.id }));
  assert.equal(obs.starts, 1);
  assert.equal(obs.sceneChanges, sceneChanges);
  await assert.rejects(studio.serial(() => studio.updateProject(project.id, { title: 'Nom modifié' })), /direct/);
  assert.equal(studio.state().media.liveStatus, 'live');
});

test('live cannot adopt another or unconfirmed recording intent', async (t) => {
  const { studio, project, obs } = await fixture(t, true);
  studio.updateRoom({ liveDestination: { name: 'Live de test', server: 'rtmp://example.com/live', key: 'private-key' } });
  const other = studio.createProject({ title: 'Autre production', format: 'podcast', participants: project.participants });
  await studio.serial(() => studio.control({ action: 'record.start', projectId: other.id }));
  const sceneChanges = obs.sceneChanges;
  await assert.rejects(studio.serial(() => studio.control({ action: 'stream.start', projectId: project.id })), /autre projet/);
  assert.equal(obs.sceneChanges, sceneChanges);
  assert.equal(studio.state().media.liveStatus, 'idle');
  await studio.serial(() => studio.control({ action: 'record.stop' }));
  studio.store.setSetting('pendingTake', { projectId: project.id });
  await assert.rejects(studio.serial(() => studio.control({ action: 'stream.start', projectId: project.id })), /vérifier/);
  assert.equal(studio.state().media.liveStatus, 'idle');
});

test('audio meters stay ephemeral and do not change persisted studio state', async (t) => {
  const { studio, obs } = await fixture(t);
  const before = studio.state();
  const received: unknown[] = [];
  const unsubscribe = studio.subscribeAudio(frame => received.push(frame));
  const frame = { capturedAt: new Date().toISOString(), inputs: [{ inputName: 'Micro 1', rmsDb: -18, peakDb: -6 }] };
  obs.emit({ type: 'audio', frame });
  assert.deepEqual(received, [frame]);
  assert.deepEqual(studio.state(), before);
  unsubscribe();
  obs.emit({ type: 'audio', frame });
  assert.equal(received.length, 1);
});

test('inactive poll before STOPPED still preserves completed file attribution', async (t) => {
  const { studio, obs, project } = await fixture(t);
  await studio.serial(() => studio.control({ action: 'record.start', projectId: project.id }));
  const id = studio.state().activeTake!.id;
  obs.externalStop();
  await studio.serial(() => undefined);
  assert.equal(studio.state().activeTake, null);
  const take = studio.state().takes.find(item => item.id === id)!;
  assert.equal(take.status, 'completed');
  assert.equal(path.basename(take.outputPath!), 'video.mkv');
});

test('old STOPPED queued behind a new start cannot clear the new take', async (t) => {
  const { studio, project } = await fixture(t);
  await studio.serial(() => studio.control({ action: 'record.start', projectId: project.id }));
  const oldId = studio.state().activeTake!.id;
  const stop = studio.serial(() => studio.control({ action: 'record.stop' }));
  const start = studio.serial(() => studio.control({ action: 'record.start', projectId: project.id }));
  await Promise.all([stop, start]);
  await studio.serial(() => undefined);
  assert.notEqual(studio.state().activeTake?.id, oldId);
  assert.equal(studio.state().activeTake?.status, 'recording');
  assert.equal(studio.state().takes.find(item => item.id === oldId)?.status, 'completed');
});

test('OBS disconnect loses attribution without stopping or silently adopting recording', async (t) => {
  const { studio, obs, project } = await fixture(t);
  await studio.serial(() => studio.control({ action: 'record.start', projectId: project.id }));
  const id = studio.state().activeTake!.id;
  await obs.disconnect();
  await studio.serial(() => undefined);
  assert.equal(studio.state().activeTake, null);
  assert.equal(studio.state().takes.find(item => item.id === id)?.status, 'interrupted');
  assert.equal(obs.stops, 0);
  await studio.serial(() => studio.connect());
  assert.equal(studio.state().obs.recording, true);
  assert.equal(studio.state().activeTake, null);
  await assert.rejects(studio.serial(() => studio.control({ action: 'record.start', projectId: project.id })), /active|cours/);
});

test('restart preserves a completed take behind stale active ID and interrupts orphan recordings', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gabin-crash-'));
  const dataDir = path.join(directory, 'db');
  const stored = new Store(dataDir);
  const timestamp = new Date().toISOString();
  const projects: Project[] = ['completed-project', 'orphan-project'].map((id) => ({ id, title: id, description: '', owner: '', format: 'podcast',
    participants: [], defaultScene: null, status: 'recording', createdAt: timestamp, updatedAt: timestamp }));
  for (const project of projects) stored.put('project', project);
  const completed: Take = { id: 'completed-take', projectId: projects[0]!.id, sequence: 1, title: 'Prise terminée', status: 'completed',
    startedAt: timestamp, endedAt: timestamp, outputPath: path.join(directory, 'completed', 'video.mkv'),
    recordingDirectory: path.join(directory, 'completed'), durationMs: 1000 };
  const orphan: Take = { ...completed, id: 'orphan-take', projectId: projects[1]!.id, title: 'Prise orpheline', status: 'recording', endedAt: null, outputPath: null };
  stored.put('take', completed);
  stored.put('take', orphan);
  // Represents a crash after saving completion, before clearing activeTakeId.
  stored.setSetting('activeTakeId', completed.id);
  stored.setSetting('pendingTake', orphan);
  stored.close();
  const obs = new Gateway();
  const recovered = new Store(dataDir);
  const restarted = new Studio(recovered, obs);
  t.after(async () => { await restarted.close(); await rm(directory, { recursive: true, force: true }); });
  const state = restarted.state();
  assert.equal(state.activeTake, null);
  assert.deepEqual(state.takes.find((take) => take.id === completed.id), completed);
  assert.equal(state.projects.find((project) => project.id === completed.projectId)?.status, 'completed');
  assert.equal(state.takes.find((take) => take.id === orphan.id)?.status, 'interrupted');
  assert.ok(state.takes.find((take) => take.id === orphan.id)?.endedAt);
  assert.equal(state.projects.find((project) => project.id === orphan.projectId)?.status, 'draft');
  assert.equal(recovered.setting('pendingTake'), null);
  assert.equal(obs.stops, 0);
});
