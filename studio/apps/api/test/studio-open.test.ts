import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApp } from '../src/app.js';
import { emptyObsState, type ObsGateway } from '../src/obs.js';
import { emptyMediaState, type MediaGateway } from '../src/media.js';
import { Studio } from '../src/studio.js';
import { Store } from '../src/store.js';
import { controlInput } from '../src/validation.js';
import { createWindowsStudioOpener } from '../src/windows-studio-opener.js';

function noOutputs() {
  let commands = 0;
  const forbidden = async (): Promise<never> => { commands++; throw new Error('Opening software must not call OBS or production outputs'); };
  const obs: ObsGateway = { getState: emptyObsState, subscribe: () => () => undefined, disconnect: async () => undefined,
    connect: forbidden, refresh: forbidden, sceneThumbnail: forbidden, setScene: forbidden, setInputMute: forbidden, setRecordDirectory: forbidden,
    startRecord: forbidden, stopRecord: forbidden, pauseRecord: forbidden, resumeRecord: forbidden, configureLocalFeed: forbidden, startStream: forbidden, stopStream: forbidden };
  const media: MediaGateway = { getState: emptyMediaState, refresh: async () => emptyMediaState(), subscribe: () => () => undefined, close: async () => undefined,
    ingestSettings: () => { commands++; throw new Error('No feed expected'); }, startLive: forbidden, stopLive: forbidden, hlsResource: forbidden };
  return { obs, media, commands: () => commands };
}

async function appFixture(t: TestContext, studioOpener?: () => Promise<void>) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nino-studio-open-')); const outputs = noOutputs();
  const app = await buildApp({ dataDir, obs: outputs.obs, media: outputs.media, studioOpener });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const auth = (await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost' } })).json();
  const headers = { authorization: `Bearer ${auth.token}` };
  const operator = (await app.inject({ method: 'POST', url: '/api/devices', headers, payload: { name: 'Accueil MK.2', kind: 'streamdeck', role: 'operator' } })).json();
  const viewer = (await app.inject({ method: 'POST', url: '/api/devices', headers, payload: { name: 'Lecture seule', kind: 'streamdeck', role: 'viewer' } })).json();
  return { app, outputs, operator: { authorization: `Bearer ${operator.token}` }, viewer: { authorization: `Bearer ${viewer.token}` } };
}

test('studio.open accepts no project, executable, arguments, URL or other command input', () => {
  assert.deepEqual(controlInput({ action: 'studio.open', requestId: 'press-1' }), { action: 'studio.open', requestId: 'press-1' });
  for (const extra of [{ projectId: 'project' }, { executable: 'other.exe' }, { command: 'cmd.exe' }, { args: [] }, { url: 'https://example.com' }, { includeLive: true }]) {
    assert.throws(() => controlInput({ action: 'studio.open', ...extra }), { statusCode: 400 });
  }
});

test('studio opening requires an authenticated operator and is disabled by default even with OBS disconnected', async t => {
  const { app, outputs, operator, viewer } = await appFixture(t);
  assert.equal((await app.inject({ method: 'POST', url: '/api/control', payload: { action: 'studio.open' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/control', headers: viewer, payload: { action: 'studio.open' } })).statusCode, 403);
  const disabled = await app.inject({ method: 'POST', url: '/api/control', headers: operator, payload: { action: 'studio.open' } });
  assert.equal(disabled.statusCode, 503); assert.equal(disabled.json().code, 'STUDIO_OPEN_UNAVAILABLE'); assert.equal(outputs.commands(), 0);
  const state = (await app.inject({ method: 'GET', url: '/api/state', headers: operator })).json();
  assert.equal(state.studioOpenAvailable, false, 'An ordinary app fixture explicitly reports that software opening is unavailable');
});

test('the paired welcome button only invokes the injected opener; retries and double presses do not start outputs or duplicate the opening', async t => {
  let opens = 0; const { app, outputs, operator } = await appFixture(t, async () => { opens++; });
  const payload = { action: 'studio.open', requestId: 'same-press' };
  const first = await app.inject({ method: 'POST', url: '/api/control', headers: operator, payload });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal((await app.inject({ method: 'POST', url: '/api/control', headers: operator, payload })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/control', headers: operator, payload: { action: 'studio.open', requestId: 'next-press' } })).statusCode, 200);
  assert.equal(opens, 1); assert.equal(outputs.commands(), 0);
  const state = first.json();
  assert.equal(state.studioOpenAvailable, true, 'Only an injected opener advertises this capability');
  assert.equal(state.obs.recording, false); assert.equal(state.obs.streaming, false); assert.equal(state.media.liveStatus, 'idle');
  assert.equal(state.activeTake, null); assert.equal(state.launch.status, 'idle'); assert.equal(state.projects.length, 0);
  assert.equal(state.streamDeck.companionConnected, false, 'An app fixture never connects to the real Companion');
});

test('an opener failure returns a bounded public error and does not claim that software or OBS opened', async t => {
  const { app, outputs, operator } = await appFixture(t, async () => { throw new Error('private-path-sentinel'); });
  const response = await app.inject({ method: 'POST', url: '/api/control', headers: operator, payload: { action: 'studio.open' } });
  assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'STUDIO_OPEN_FAILED');
  assert.equal(response.body.includes('private-path-sentinel'), false); assert.equal(outputs.commands(), 0);
});

test('concurrent open requests share their task and another press can retry after the short opening window', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nino-studio-open-concurrent-')); const outputs = noOutputs();
  let now = 1000; let opens = 0; let release!: () => void;
  const studio = new Studio(new Store(directory), outputs.obs, outputs.media, { now: () => now, autoIntervalMs: 0,
    studioOpener: () => { opens++; return new Promise<void>(resolve => { release = resolve; }); } });
  t.after(async () => { await studio.close(); await rm(directory, { recursive: true, force: true }); });
  const operator = studio.store.createDevice('MK.2', 'streamdeck', 'operator', true); const actor = { deviceId: operator.device.id };
  const first = studio.control({ action: 'studio.open' }, actor); const second = studio.control({ action: 'studio.open' }, actor);
  await Promise.resolve(); assert.equal(opens, 1); release(); await Promise.all([first, second]);
  now += 2000; await studio.control({ action: 'studio.open' }, actor); assert.equal(opens, 1);
  now += 1001; const later = studio.control({ action: 'studio.open' }, actor); await Promise.resolve(); assert.equal(opens, 2); release(); await later;
  assert.equal(outputs.commands(), 0);
});

function fakeSpawner() {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = []; const children: Array<EventEmitter & { unref: () => void }> = [];
  const spawnProcess = ((command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options }); const child = Object.assign(new EventEmitter(), { unref() {} }); children.push(child);
    queueMicrotask(() => child.emit('spawn')); return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { calls, children, spawnProcess };
}
const moduleUrl = pathToFileURL(path.resolve('/Nino installation/app/apps/api/src/windows-studio-opener.ts')).href;
const installedLauncher = path.resolve('/Nino installation/windows/Launch-Nino.ps1');

test('the platform boundary disables the native opener outside Windows without reading paths or spawning', () => {
  const opener = createWindowsStudioOpener({ platform: 'darwin', exists: () => { assert.fail('No filesystem lookup on another platform'); }, spawnProcess: (() => assert.fail('No native process on another platform')) as unknown as typeof spawn });
  assert.equal(opener, undefined);
});

test('the Windows opener spawns only the fixed installed script with separate argv and no shell, and reuses an active launcher', async () => {
  const fake = fakeSpawner();
  const opener = createWindowsStudioOpener({ platform: 'win32', moduleUrl, systemRoot: 'C:\\Windows', exists: candidate => candidate === installedLauncher, spawnProcess: fake.spawnProcess })!;
  const first = opener(); assert.equal(opener(), first); await first;
  assert.equal(opener(), first, 'A still-running launcher is reused after accepting the first request');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(fake.calls[0].args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installedLauncher]);
  assert.deepEqual(fake.calls[0].options, { cwd: path.dirname(installedLauncher), shell: false, windowsHide: true, stdio: 'ignore' });
  fake.children[0].emit('close', 0); await opener(); assert.equal(fake.calls.length, 2);
});

test('missing launcher or a non-local Windows system directory never spawns a process', async () => {
  const fake = fakeSpawner();
  const missing = createWindowsStudioOpener({ platform: 'win32', moduleUrl, exists: () => false, spawnProcess: fake.spawnProcess })!;
  await assert.rejects(missing(), /introuvable/);
  const remote = createWindowsStudioOpener({ platform: 'win32', moduleUrl, systemRoot: '\\\\remote\\Windows', exists: () => true, spawnProcess: fake.spawnProcess })!;
  await assert.rejects(remote(), /dossier système/);
  assert.equal(fake.calls.length, 0);
});
