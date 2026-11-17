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

/** A driver with only the mandatory surface: no media, no guests, no pause. */
class MinimalDriver implements CaptureDriver {
  constructor(readonly software: CaptureDriver['software'] = undefined, readonly capabilities: CaptureDriver['capabilities'] = undefined) {}
  private readonly state: CaptureState = { ...emptyCaptureState(), connected: true, scenes: ['Plateau'], currentScene: 'Plateau' };
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
  subscribe(_listener: (event: CaptureEvent) => void) { return () => undefined; }
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
