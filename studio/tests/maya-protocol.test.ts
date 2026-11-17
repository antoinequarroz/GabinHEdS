import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CaptureEvent } from '../apps/api/src/capture.js';
import { CaptureUnsupported } from '../apps/api/src/capture.js';
import { MayaStudioDriver, msTimecode } from '../apps/api/src/maya.js';
import { RealObsGateway } from '../apps/api/src/obs.js';
import { Store } from '../apps/api/src/store.js';
import { Studio } from '../apps/api/src/studio.js';
import { startFakeMaya } from './fake-maya.js';

const waitUntil = async (condition: () => boolean, label: string, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Délai dépassé : ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

test('timecodes follow the OBS format', () => {
  assert.equal(msTimecode(0), '00:00:00.000');
  assert.equal(msTimecode(3_723_045), '01:02:03.045');
});

test('the Maya driver speaks the suite protocol and confirms every command by reading back', async (t) => {
  const maya = await startFakeMaya({ token: 'jeton-suite' });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nino-maya-'));
  const driver = new MayaStudioDriver();
  t.after(async () => { await driver.disconnect(); await maya.close(); await rm(directory, { recursive: true, force: true }); });
  const events: CaptureEvent[] = [];
  driver.subscribe(event => events.push(event));

  const connected = await driver.connect(maya.url, 'jeton-suite');
  assert.equal(connected.connected, true);
  assert.deepEqual(connected.scenes, ['Plateau', 'Caméra 1', 'Caméra 2']);
  assert.equal(connected.currentScene, 'Plateau');
  assert.deepEqual(connected.inputs, [], 'Maya v0.1 exposes no audio inputs');

  await driver.setScene('Caméra 1');
  assert.equal((await driver.refresh(true)).currentScene, 'Caméra 1');

  await driver.setRecordDirectory(directory);
  await driver.startRecord();
  const recording = await driver.refresh(true);
  assert.equal(recording.recording, true);
  assert.equal(recording.recordingDirectory, directory);
  const started = maya.requests.find(request => request.type === 'StartRecording')!;
  assert.equal(path.dirname(String(started.data.path)), directory, 'Each take is written inside the folder Nino chose');
  const stopped = await driver.stopRecord();
  assert.equal(stopped.outputPath, started.data.path);
  assert.equal(await readFile(stopped.outputPath!, 'utf8'), 'fake maya recording');
  await waitUntil(() => events.some(event => event.type === 'recordStopped' && event.outputPath === stopped.outputPath), 'recordStopped');
  assert.equal((await driver.refresh(true)).recording, false);

  await driver.configureLocalFeed({ server: 'rtmp://127.0.0.1:1935/', key: 'nino/program' });
  await driver.startStream();
  assert.equal(maya.outputs.stream?.target, 'rtmp://127.0.0.1:1935/nino/program');
  assert.equal((await driver.refresh(true)).streaming, true);
  await driver.stopStream();

  const thumbnail = await driver.sceneThumbnail('Caméra 2');
  assert.equal(thumbnail.available, true);
  assert.match(thumbnail.imageData!, /^data:image\/jpeg;base64,/);
  assert.equal((await driver.sceneThumbnail('Inconnue')).available, false);

  await assert.rejects(driver.pauseRecord(), CaptureUnsupported);
  await assert.rejects(driver.setInputMute(), CaptureUnsupported);
});

test('a wrong token is reported plainly and leaves the driver disconnected', async (t) => {
  const maya = await startFakeMaya({ token: 'jeton-suite' });
  const driver = new MayaStudioDriver();
  t.after(async () => { await driver.disconnect(); await maya.close(); });
  await assert.rejects(driver.connect(maya.url, 'mauvais'), /refusé le jeton/);
  assert.equal(driver.getState().connected, false);
});

test('a lost link keeps the last known recording state and flags it', async (t) => {
  const maya = await startFakeMaya();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nino-maya-'));
  const driver = new MayaStudioDriver();
  t.after(async () => { await driver.disconnect(); await rm(directory, { recursive: true, force: true }); });
  await driver.connect(maya.url, '');
  await driver.setRecordDirectory(directory);
  await driver.startRecord();
  await driver.refresh(true);
  await maya.close();
  await waitUntil(() => !driver.getState().connected, 'déconnexion');
  assert.equal(driver.getState().recording, true, 'Disconnected does not mean stopped');
  assert.match(driver.getState().error ?? '', /interrompue/);
});

test('a studio switched to Maya records a take end to end, and refuses what Maya cannot do', async (t) => {
  const maya = await startFakeMaya();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nino-maya-studio-'));
  const studio = new Studio(new Store(path.join(directory, 'db')), new RealObsGateway(), undefined,
    { autoIntervalMs: 0, captureDrivers: { maya: () => new MayaStudioDriver() } });
  t.after(async () => { await studio.close(); await maya.close(); await rm(directory, { recursive: true, force: true }); });

  studio.updateRoom({ captureSoftware: 'maya', obsUrl: maya.url, obsPassword: '', recordingRoot: path.join(directory, 'recordings'),
    defaultScenes: { podcast: 'Plateau', roundtable: 'Plateau', slides: 'Plateau' } });
  await studio.serial(() => studio.connect());
  assert.equal(studio.state().capture?.software, 'maya');
  assert.equal(studio.state().obs.connected, true);

  const project = studio.createProject({ title: 'Podcast Maya', format: 'podcast',
    participants: [{ id: 'p1', name: 'Camille', micInput: null, sceneName: 'Caméra 1' }] });
  const preparation = await studio.serial(() => studio.preparation(project.id));
  assert.equal(preparation.checks.find(check => check.id === 'mics')?.status, 'warning', 'No mic control: a warning, not a block');
  assert.equal(preparation.canStart, true);

  await studio.serial(() => studio.control({ action: 'record.start', projectId: project.id }));
  const take = studio.state().activeTake!;
  assert.equal(take.status, 'recording');
  assert.equal(maya.programName(), 'Plateau');

  await assert.rejects(studio.serial(() => studio.control({ action: 'record.pause' })), { code: 'CAPTURE_UNSUPPORTED' });
  await assert.rejects(studio.serial(() => studio.control({ action: 'auto.start', projectId: project.id })), { code: 'CAPTURE_UNSUPPORTED' });

  await studio.serial(() => studio.control({ action: 'scene.set', sceneName: 'Caméra 1' }));
  assert.equal(maya.programName(), 'Caméra 1');

  await studio.serial(() => studio.control({ action: 'record.stop', expectedTakeId: take.id }));
  await waitUntil(() => studio.state().takes.find(item => item.id === take.id)?.status === 'completed', 'prise terminée');
  const completed = studio.state().takes.find(item => item.id === take.id)!;
  assert.equal(path.dirname(completed.outputPath!), take.recordingDirectory);
  assert.equal(await readFile(completed.outputPath!, 'utf8'), 'fake maya recording');
});
