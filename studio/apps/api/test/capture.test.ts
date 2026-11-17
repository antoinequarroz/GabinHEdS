import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CaptureState, SceneThumbnail } from '@nino/shared';
import { captureHas, captureInfo, emptyCaptureState, fullCaptureCapabilities, type CaptureDriver, type CaptureEvent } from '../src/capture.js';
import { RealObsGateway } from '../src/obs.js';
import { Store } from '../src/store.js';
import { Studio } from '../src/studio.js';
import { ApiFailure, roomInput } from '../src/validation.js';

/** A driver with only the mandatory surface: no media, no guests, no pause. */
class MinimalDriver implements CaptureDriver {
  constructor(readonly software: CaptureDriver['software'] = undefined, readonly capabilities: CaptureDriver['capabilities'] = undefined, connected = true) {
    this.state = { ...emptyCaptureState(), connected, scenes: ['Plateau'], currentScene: 'Plateau' };
  }
  private readonly state: CaptureState;
  listeners = 0;
  getState() { return structuredClone(this.state); }
  async connect() { return this.getState(); }
  async disconnect() {}
  async refresh() { return this.getState(); }
  async sceneThumbnail(sceneName: string): Promise<SceneThumbnail> { return { sceneName, imageData: null, capturedAt: null, available: false }; }
  async setScene() {}
  async setInputMute() {}
  async setRecordDirectory() {}
  async startRecord() {}
  async stopRecord() { return { outputPath: null }; }
  async pauseRecord() {}
  async resumeRecord() {}
  async configureLocalFeed() {}
  async startStream() {}
  async stopStream() {}
  subscribe(_listener: (event: CaptureEvent) => void) { this.listeners++; return () => { this.listeners--; }; }
}

test('the OBS driver declares every capability Nino uses today', () => {
  const info = captureInfo(new RealObsGateway());
  assert.equal(info.software, 'obs');
  assert.equal(info.label, 'OBS Studio');
  assert.deepEqual(info.capabilities, [...fullCaptureCapabilities]);
});

test('an older driver without declarations is OBS, minus the optional methods it lacks', () => {
  const driver = new MinimalDriver();
  const info = captureInfo(driver);
  assert.equal(info.software, 'obs');
  assert.equal(captureHas(driver, 'media.play'), false, 'No media methods, no media capability');
  assert.equal(captureHas(driver, 'guests.browser'), false, 'No guest methods, no guest capability');
  assert.equal(captureHas(driver, 'record.pause'), true);
});

test('declared capabilities win and are published in the studio state', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nino-capture-'));
  const store = new Store(dataDir);
  const driver = new MinimalDriver('maya', ['scene.thumbnails']);
  const studio = new Studio(store, driver);
  try {
    const state = studio.state();
    assert.deepEqual(state.capture, { software: 'maya', label: 'Maya Studio', capabilities: ['scene.thumbnails'] });
    assert.equal(state.obs.currentScene, 'Plateau', 'Existing controllers still read the capture state under obs');
  } finally {
    await studio.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function withStudio(capture: CaptureDriver, drivers: Partial<Record<'obs' | 'streamlabs' | 'maya', () => CaptureDriver>>,
  run: (studio: Studio, store: Store) => Promise<void> | void): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nino-capture-'));
  const store = new Store(dataDir);
  const studio = new Studio(store, capture, undefined, { captureDrivers: drivers, autoIntervalMs: 0 });
  try { await run(studio, store); } finally { await studio.close(); await rm(dataDir, { recursive: true, force: true }); }
}
const failureCode = (code: string) => (error: unknown) => error instanceof ApiFailure && error.code === code;

test('a room saved before the choice existed is an OBS room', async () => {
  await withStudio(new MinimalDriver(), {}, (studio, store) => {
    assert.equal(store.publicRoom().captureSoftware, 'obs');
    assert.deepEqual(studio.state().captureAvailable, ['obs']);
  });
});

test('a software without a driver in this installation is refused, nothing changes', async () => {
  await withStudio(new MinimalDriver('obs', undefined, false), {}, (studio, store) => {
    assert.throws(() => studio.updateRoom({ captureSoftware: 'maya', name: 'Studio B' }), failureCode('CAPTURE_DRIVER_UNAVAILABLE'));
    assert.equal(store.publicRoom().captureSoftware, 'obs');
    assert.notEqual(store.publicRoom().name, 'Studio B');
  });
});

test('the software cannot change while the current one is connected', async () => {
  const maya = new MinimalDriver('maya', ['scene.thumbnails'], false);
  await withStudio(new MinimalDriver('obs', undefined, true), { maya: () => maya }, (studio, store) => {
    assert.throws(() => studio.updateRoom({ captureSoftware: 'maya' }), failureCode('CAPTURE_CONNECTED'));
    assert.equal(store.publicRoom().captureSoftware, 'obs');
    assert.equal(studio.state().capture?.software, 'obs');
  });
});

test('switching software swaps the driver and is published to every controller', async () => {
  const obs = new MinimalDriver('obs', undefined, false);
  const maya = new MinimalDriver('maya', ['scene.thumbnails'], false);
  await withStudio(obs, { maya: () => maya }, (studio, store) => {
    assert.deepEqual(studio.state().captureAvailable, ['obs', 'maya']);
    studio.updateRoom({ captureSoftware: 'maya', obsUrl: 'ws://127.0.0.1:4460' });
    assert.equal(store.publicRoom().captureSoftware, 'maya');
    assert.equal(studio.capture, maya);
    assert.equal(obs.listeners, 0, 'The previous driver no longer feeds the studio');
    assert.equal(maya.listeners, 1);
    assert.deepEqual(studio.state().capture, { software: 'maya', label: 'Maya Studio', capabilities: ['scene.thumbnails'] });
    studio.updateRoom({ captureSoftware: 'obs' });
    assert.equal(studio.capture, obs, 'Coming back reuses the original driver');
  });
});

test('a saved software with no driver falls back to what is really driven', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nino-capture-'));
  try {
    const first = new Studio(new Store(dataDir), new MinimalDriver('maya', [], false), undefined, { autoIntervalMs: 0 });
    assert.equal(first.store.publicRoom().captureSoftware, 'maya');
    await first.close();
    const second = new Studio(new Store(dataDir), new MinimalDriver('obs', undefined, false), undefined, { autoIntervalMs: 0 });
    assert.equal(second.store.publicRoom().captureSoftware, 'obs');
    await second.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('the room input accepts only known capture software', () => {
  assert.equal(roomInput({ captureSoftware: 'maya' }).captureSoftware, 'maya');
  assert.throws(() => roomInput({ captureSoftware: 'vmix' }), ApiFailure);
  assert.throws(() => roomInput({ obsUrl: 'ws://192.168.1.20:4460' }), ApiFailure, 'The capture software stays on the room PC');
});
