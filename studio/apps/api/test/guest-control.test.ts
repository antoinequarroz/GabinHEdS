import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import type { AuthResult, ControlCommand, GuestInvitation, GuestSession, GuestSlot, MediaState, ObsState, Project, StudioState } from '@gabin/shared';
import { buildApp } from '../src/app.js';
import { buildGuestApp } from '../src/guest-app.js';
import { emptyObsState, ObsGuestFailure, type ObsEvent, type ObsGateway, type ObsGuestSourceOptions } from '../src/obs.js';
import { emptyMediaState, type MediaGateway } from '../src/media.js';

/** Tests the public control boundary with a deterministic OBS confirmation fixture.
 * Real source ownership and AV decoding are covered by the adapter/browser tests. */
class GuestObs implements ObsGateway {
  state: ObsState = { ...emptyObsState(), connected: true, scenes: ['Podcast'], currentScene: 'Podcast', inputs: [{ name: 'Micro salle', kind: 'audio', muted: false, volumeDb: 0 }] };
  private listeners = new Set<(event: ObsEvent) => void>();
  private owners = new Map<string, { id: string; projectId: string }>();
  lastSources: ObsGuestSourceOptions['guests'] = [];
  prepares = 0; virtualStarts = 0; recordStarts = 0; liveStarts = 0; sceneChanges = 0;
  mutes: { name: string; muted: boolean }[] = [];
  collision = false;
  afterUnmute: (() => Promise<void>) | null = null;
  getState(): ObsState { return structuredClone(this.state); }
  subscribe(listener: (event: ObsEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(): void { for (const listener of this.listeners) listener({ type: 'state', state: this.getState() }); }
  async connect(): Promise<ObsState> { this.state.connected = true; return this.refresh(); }
  async disconnect(): Promise<void> { this.state.connected = false; }
  async refresh(): Promise<ObsState> { this.emit(); return this.getState(); }
  async sceneThumbnail(sceneName: string) { return { sceneName, available: false, imageData: null, capturedAt: null }; }
  async setScene(sceneName: string): Promise<void> { this.sceneChanges++; this.state.currentScene = sceneName; }
  async setInputMute(name: string, muted: boolean): Promise<void> {
    this.mutes.push({ name, muted });
    const input = this.state.inputs.find(item => item.name === name);
    if (!input) throw new Error('Missing input');
    input.muted = muted;
    if (!muted) await this.afterUnmute?.();
  }
  async setRecordDirectory(directory: string): Promise<void> { this.state.recordingDirectory = directory; }
  async startRecord(): Promise<void> { this.recordStarts++; this.state.recording = true; }
  async stopRecord() { this.state.recording = false; return { outputPath: null }; }
  async pauseRecord(): Promise<void> { this.state.paused = true; }
  async resumeRecord(): Promise<void> { this.state.paused = false; }
  async configureLocalFeed(): Promise<void> {}
  async startStream(): Promise<void> { this.liveStarts++; this.state.streaming = true; }
  async stopStream(): Promise<void> { this.state.streaming = false; }
  async startVirtualCamera(): Promise<void> { this.virtualStarts++; }
  async prepareGuestSources(options: ObsGuestSourceOptions): Promise<void> {
    if (this.collision) throw new ObsGuestFailure('Source étrangère : collision refusée.');
    this.prepares++; this.lastSources = structuredClone(options.guests);
    for (const guest of options.guests) {
      this.owners.set(guest.inputName, { id: guest.id, projectId: options.projectId });
      if (!this.state.scenes.includes(guest.sceneName)) this.state.scenes.push(guest.sceneName);
      if (!this.state.inputs.some(input => input.name === guest.inputName)) this.state.inputs.push({ name: guest.inputName, kind: 'browser_source', muted: true, volumeDb: 0 });
    }
  }
  async guestSourceOwned(inputName: string, guestId: string, projectId: string): Promise<boolean> {
    const owner = this.owners.get(inputName);
    return owner?.id === guestId && owner.projectId === projectId;
  }
  tamper(inputName: string): void { this.owners.set(inputName, { id: 'foreign', projectId: 'foreign' }); }
}
class NoLive implements MediaGateway {
  getState(): MediaState { return emptyMediaState(); }
  async refresh(): Promise<MediaState> { return this.getState(); }
  ingestSettings() { return { server: 'rtmp://127.0.0.1:1935/test', key: 'test' }; }
  async startLive(): Promise<void> { throw new Error('Guest controls must not start live'); }
  async stopLive(): Promise<void> {}
  async hlsResource(): Promise<Response> { return new Response('', { status: 404 }); }
  subscribe(): () => void { return () => undefined; }
  async close(): Promise<void> {}
}
const headers = (auth: AuthResult) => ({ host: 'localhost:4310', authorization: `Bearer ${auth.token}` });
const tokenFrom = (url: string): string => new URL(url).hash.split('/').at(-1)!;

async function fixture(t: TestContext, now?: () => number) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nino-guest-control-'));
  const obs = new GuestObs();
  const app = await buildApp({ dataDir: dir, obs, media: new NoLive(), guestConfig: { now } });
  const guestApp = await buildGuestApp({ guests: app.guests });
  const base = await guestApp.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await guestApp.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const pc: AuthResult = (await app.inject({ method: 'POST', url: '/api/auth/local', headers: { host: 'localhost:4310' } })).json();
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/room', headers: headers(pc), payload: { recordingRoot: path.join(dir, 'recordings') } })).statusCode, 200);
  const paired = async (role: 'viewer' | 'operator'): Promise<AuthResult> => {
    const code = (await app.inject({ method: 'POST', url: '/api/pairing', headers: headers(pc), payload: { role, kind: 'ipad' } })).json();
    return (await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: code.code, kind: 'ipad', name: role } })).json();
  };
  const ipad = await paired('operator'); const viewer = await paired('viewer');
  const deck: AuthResult = (await app.inject({ method: 'POST', url: '/api/devices', headers: headers(pc), payload: { name: 'Deck', kind: 'streamdeck', role: 'operator' } })).json();
  const project: Project = (await app.inject({ method: 'POST', url: '/api/projects', headers: headers(pc), payload: { title: 'Podcast distant', format: 'podcast', defaultScene: 'Podcast',
    participants: [{ id: 'local', name: 'Camille', micInput: 'Micro salle', sceneName: 'Podcast' }] } })).json();
  const control = (auth: AuthResult, command: ControlCommand) => app.inject({ method: 'POST', url: '/api/control', headers: headers(auth), payload: command });
  const invite = async (slot: 1 | 2 = 1, auth = pc): Promise<GuestInvitation> => {
    const result = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/guests/invitations`, headers: headers(auth), payload: { slot, name: `Invité ${slot}` } });
    assert.equal(result.statusCode, 200, result.body); return result.json();
  };
  const state = async (): Promise<StudioState> => (await app.inject({ url: '/api/state', headers: headers(pc) })).json();
  const waitState = async (check: (state: StudioState) => boolean): Promise<StudioState> => {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) { const value = await state(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Expected studio state was not confirmed');
  };
  return { app, guestApp, obs, pc, ipad, viewer, deck, project, control, invite, state, waitState, base };
}

async function peer(base: string, session: GuestSession): Promise<WebSocket> {
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/guest/events`);
  socket.on('error', () => undefined);
  await once(socket, 'open');
  const welcome = new Promise<void>((resolve, reject) => {
    socket.on('message', raw => { const value = JSON.parse(raw.toString()); if (value.type === 'welcome') resolve(); if (value.type === 'error') reject(new Error(value.error)); });
  });
  socket.send(JSON.stringify({ type: 'auth', token: session.token })); await welcome;
  return socket;
}
async function readyCall(ctx: Awaited<ReturnType<typeof fixture>>, invitation: GuestInvitation) {
  const bridgeResult = await ctx.app.inject({ method: 'POST', url: `/api/projects/${ctx.project.id}/guests/bridge-session`, headers: headers(ctx.pc), payload: {} });
  assert.equal(bridgeResult.statusCode, 200, bridgeResult.body);
  const bridgeSession: GuestSession = bridgeResult.json();
  const guestSession = ctx.app.guests.join(tokenFrom(invitation.url), 'Alice');
  const bridge = await peer(ctx.base, bridgeSession); const guest = await peer(ctx.base, guestSession);
  bridge.send(JSON.stringify({ type: 'media', ready: true, video: true, audio: true }));
  bridge.send(JSON.stringify({ type: 'media', guestId: invitation.guestId, ready: true, video: true, audio: true }));
  await ctx.waitState(state => state.guestRooms?.[ctx.project.id]?.guests.some(slot => slot.id === invitation.guestId && slot.status === 'ready') ?? false);
  return { bridge, guest, bridgeSession, guestSession };
}
function slot(state: StudioState, projectId: string, guestId: string): GuestSlot {
  const guest = state.guestRooms?.[projectId]?.guests.find(item => item.id === guestId); assert.ok(guest); return guest;
}

test('all guest commands require an authenticated operator; iPad and Stream Deck use the same control API', async t => {
  const ctx = await fixture(t); const invitation = await ctx.invite();
  const commands: ControlCommand[] = [
    { action: 'guest.prepare', projectId: ctx.project.id }, { action: 'guest.admit', guestId: invitation.guestId },
    { action: 'guest.mute', guestId: invitation.guestId, muted: true }, { action: 'guest.scene', guestId: invitation.guestId },
    { action: 'guest.remove', guestId: invitation.guestId }, { action: 'guest.bridge.stop', projectId: ctx.project.id },
  ];
  for (const command of commands) {
    assert.equal((await ctx.app.inject({ method: 'POST', url: '/api/control', payload: command })).statusCode, 401);
    assert.equal((await ctx.control(ctx.viewer, command)).statusCode, 403);
  }
  assert.equal((await ctx.app.inject({ method: 'POST', url: `/api/projects/${ctx.project.id}/guests/invitations`, headers: headers(ctx.viewer), payload: { slot: 2, name: 'Blocked' } })).statusCode, 403);
  assert.equal(ctx.obs.prepares, 0); assert.equal(ctx.obs.mutes.length, 0);
  assert.equal((await ctx.control(ctx.ipad, { action: 'guest.prepare', projectId: ctx.project.id })).statusCode, 200);
  for (const controller of [ctx.ipad, ctx.deck]) assert.equal((await ctx.app.inject({ method: 'POST', url: `/api/projects/${ctx.project.id}/guests/bridge-session`, headers: headers(controller), payload: {} })).statusCode, 403, 'media capture is scoped to the PC while remote controls remain available');
  const connected = await readyCall(ctx, invitation);
  assert.equal((await ctx.control(ctx.deck, { action: 'guest.admit', guestId: invitation.guestId })).statusCode, 200);
  assert.equal(slot(await ctx.state(), ctx.project.id, invitation.guestId).admitted, true);
  assert.equal((await ctx.control(ctx.ipad, { action: 'guest.mute', guestId: invitation.guestId, muted: true })).statusCode, 200);
  assert.equal(ctx.obs.state.inputs.find(input => input.name === ctx.app.guests.getGuest(invitation.guestId).inputName)?.muted, true);
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.mute', guestId: invitation.guestId, muted: false })).statusCode, 200);
  assert.equal(ctx.obs.recordStarts, 0); assert.equal(ctx.obs.liveStarts, 0);
  connected.guest.close(); connected.bridge.close();
});

test('admission without live media rolls OBS microphone back to mute, and a guest plan requires source decoding', async t => {
  const ctx = await fixture(t); const invitation = await ctx.invite();
  const noPreparation = await ctx.control(ctx.pc, { action: 'guest.admit', guestId: invitation.guestId });
  assert.equal(noPreparation.statusCode, 409); assert.equal(ctx.obs.mutes.length, 0);
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.prepare', projectId: ctx.project.id })).statusCode, 200);
  const missingMedia = await ctx.control(ctx.ipad, { action: 'guest.admit', guestId: invitation.guestId });
  assert.equal(missingMedia.statusCode, 409, missingMedia.body);
  assert.deepEqual(ctx.obs.mutes.slice(-2).map(item => item.muted), [false, true]);
  assert.equal(slot(await ctx.state(), ctx.project.id, invitation.guestId).admitted, false);
  const connected = await readyCall(ctx, invitation);
  assert.equal((await ctx.control(ctx.deck, { action: 'guest.admit', guestId: invitation.guestId })).statusCode, 200);
  const beforeReady = await ctx.control(ctx.ipad, { action: 'guest.scene', guestId: invitation.guestId });
  assert.equal(beforeReady.statusCode, 409); assert.equal(ctx.obs.sceneChanges, 0);
  const prepared = ctx.obs.lastSources.find(item => item.id === invitation.guestId)!;
  const sourceSession = ctx.app.guests.claimSource(tokenFrom(prepared.url));
  const source = await peer(ctx.base, sourceSession);
  source.send(JSON.stringify({ type: 'media', guestId: invitation.guestId, ready: true, video: true, audio: true }));
  await ctx.waitState(state => slot(state, ctx.project.id, invitation.guestId).sourceReady);
  assert.equal((await ctx.control(ctx.ipad, { action: 'guest.scene', guestId: invitation.guestId })).statusCode, 200);
  assert.equal(ctx.obs.state.currentScene, ctx.app.guests.getGuest(invitation.guestId).sceneName);
  source.close(); connected.guest.close(); connected.bridge.close();
});

test('remove and bridge.stop mute confirmed OBS inputs; replaying a control request never repeats its side effect', async t => {
  const ctx = await fixture(t); const invitation = await ctx.invite();
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.prepare', projectId: ctx.project.id, requestId: 'prepare-once' })).statusCode, 200);
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.prepare', projectId: ctx.project.id, requestId: 'prepare-once' })).statusCode, 200);
  assert.equal(ctx.obs.prepares, 1);
  const conflicting = await ctx.control(ctx.pc, { action: 'guest.bridge.stop', projectId: ctx.project.id, requestId: 'prepare-once' });
  assert.equal(conflicting.statusCode, 409);
  const connected = await readyCall(ctx, invitation);
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.admit', guestId: invitation.guestId })).statusCode, 200);
  assert.equal((await ctx.control(ctx.ipad, { action: 'guest.bridge.stop', projectId: ctx.project.id })).statusCode, 200);
  let value = slot(await ctx.state(), ctx.project.id, invitation.guestId); assert.equal(value.admitted, false); assert.equal(value.muted, true);
  assert.equal(ctx.obs.state.inputs.find(input => input.name === value.inputName)?.muted, true);
  assert.throws(() => ctx.app.guests.resume(connected.bridgeSession.token), { statusCode: 401 });
  const resumed = await readyCall(ctx, await ctx.invite());
  assert.equal((await ctx.control(ctx.deck, { action: 'guest.admit', guestId: invitation.guestId })).statusCode, 200);
  assert.equal((await ctx.control(ctx.deck, { action: 'guest.remove', guestId: invitation.guestId, requestId: 'remove-once' })).statusCode, 200);
  assert.equal((await ctx.control(ctx.deck, { action: 'guest.remove', guestId: invitation.guestId, requestId: 'remove-once' })).statusCode, 200);
  value = slot(await ctx.state(), ctx.project.id, invitation.guestId); assert.equal(value.status, 'removed'); assert.equal(value.admitted, false);
  assert.equal(ctx.obs.state.inputs.find(input => input.name === value.inputName)?.muted, true);
  assert.throws(() => ctx.app.guests.resume(resumed.guestSession.token), { statusCode: 401 });
  resumed.guest.close(); resumed.bridge.close(); connected.guest.close(); connected.bridge.close();
});

test('source collisions are refused before mutation and an OBS source replaced after preparation is never controlled', async t => {
  const ctx = await fixture(t); const invitation = await ctx.invite();
  ctx.obs.collision = true;
  const collision = await ctx.control(ctx.pc, { action: 'guest.prepare', projectId: ctx.project.id });
  assert.ok(collision.statusCode >= 400); assert.equal(ctx.obs.prepares, 0); assert.equal(ctx.obs.virtualStarts, 0);
  ctx.obs.collision = false;
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.prepare', projectId: ctx.project.id })).statusCode, 200);
  const connected = await readyCall(ctx, invitation);
  const inputName = ctx.app.guests.getGuest(invitation.guestId).inputName;
  ctx.obs.tamper(inputName); const beforeMutes = ctx.obs.mutes.length;
  const result = await ctx.control(ctx.pc, { action: 'guest.admit', guestId: invitation.guestId });
  assert.ok(result.statusCode >= 400); assert.equal(ctx.obs.mutes.length, beforeMutes, 'a foreign replacement is never unmuted, including rollback');
  assert.equal(slot(await ctx.state(), ctx.project.id, invitation.guestId).admitted, false);
  connected.guest.close(); connected.bridge.close();
});

test('revocation during an OBS unmute aborts admission and restores the microphone before returning an error', async t => {
  const ctx = await fixture(t); const invitation = await ctx.invite();
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.prepare', projectId: ctx.project.id })).statusCode, 200);
  const connected = await readyCall(ctx, invitation);
  ctx.obs.afterUnmute = async () => {
    ctx.obs.afterUnmute = null;
    assert.equal((await ctx.app.inject({ method: 'DELETE', url: `/api/devices/${ctx.ipad.device.id}`, headers: headers(ctx.pc) })).statusCode, 204);
  };
  const result = await ctx.control(ctx.ipad, { action: 'guest.admit', guestId: invitation.guestId });
  assert.equal(result.statusCode, 403, result.body);
  const value = slot(await ctx.state(), ctx.project.id, invitation.guestId); assert.equal(value.admitted, false); assert.equal(value.muted, true);
  assert.equal(ctx.obs.state.inputs.find(input => input.name === value.inputName)?.muted, true);
  assert.equal((await ctx.control(ctx.ipad, { action: 'guest.remove', guestId: invitation.guestId })).statusCode, 401);
  connected.guest.close(); connected.bridge.close();
});

test('the initial OBS media wait keeps admission until actual decoding, then any source media loss mutes immediately', async t => {
  let now = Date.now(); const ctx = await fixture(t, () => now); const invitation = await ctx.invite();
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.prepare', projectId: ctx.project.id })).statusCode, 200);
  const connected = await readyCall(ctx, invitation);
  const sourceSession = ctx.app.guests.claimSource(tokenFrom(ctx.obs.lastSources.find(item => item.id === invitation.guestId)!.url));
  const source = await peer(ctx.base, sourceSession);
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.admit', guestId: invitation.guestId })).statusCode, 200);
  source.send(JSON.stringify({ type: 'media', guestId: invitation.guestId, ready: false, video: false, audio: false }));
  let value = await ctx.waitState(state => !!slot(state, ctx.project.id, invitation.guestId).error);
  assert.equal(slot(value, ctx.project.id, invitation.guestId).admitted, true, 'the first decode can arrive after admission');
  now += 5000;
  assert.equal(slot(await ctx.state(), ctx.project.id, invitation.guestId).admitted, true);
  source.send(JSON.stringify({ type: 'media', guestId: invitation.guestId, ready: true, video: true, audio: true }));
  await ctx.waitState(state => slot(state, ctx.project.id, invitation.guestId).sourceReady);
  now += 20_000;
  assert.equal(slot(await ctx.state(), ctx.project.id, invitation.guestId).admitted, true, 'successful first decoding clears the initial timeout');
  source.send(JSON.stringify({ type: 'media', guestId: invitation.guestId, ready: false, video: false, audio: false }));
  value = await ctx.waitState(state => !slot(state, ctx.project.id, invitation.guestId).admitted && state.obs.inputs.find(input => input.name === slot(state, ctx.project.id, invitation.guestId).inputName)?.muted === true);
  assert.equal(slot(value, ctx.project.id, invitation.guestId).muted, true);
  source.close(); connected.guest.close(); connected.bridge.close();
});

test('OBS decoding that never arrives times out after the bounded initial wait and restores mute', async t => {
  let now = Date.now(); const ctx = await fixture(t, () => now); const invitation = await ctx.invite();
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.prepare', projectId: ctx.project.id })).statusCode, 200);
  const connected = await readyCall(ctx, invitation);
  assert.equal((await ctx.control(ctx.deck, { action: 'guest.admit', guestId: invitation.guestId })).statusCode, 200);
  now += 15_001;
  const value = await ctx.waitState(state => !slot(state, ctx.project.id, invitation.guestId).admitted && state.obs.inputs.find(input => input.name === slot(state, ctx.project.id, invitation.guestId).inputName)?.muted === true);
  assert.equal(slot(value, ctx.project.id, invitation.guestId).muted, true);
  assert.match(slot(value, ctx.project.id, invitation.guestId).error || '', /OBS/);
  connected.guest.close(); connected.bridge.close();
});

test('OBS microphone acknowledgements without confirmation cannot admit a guest', async t => {
  const ctx = await fixture(t); const invitation = await ctx.invite();
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.prepare', projectId: ctx.project.id })).statusCode, 200);
  const connected = await readyCall(ctx, invitation);
  ctx.obs.afterUnmute = async () => { ctx.obs.state.inputs.find(input => input.name === ctx.app.guests.getGuest(invitation.guestId).inputName)!.muted = true; };
  const result = await ctx.control(ctx.ipad, { action: 'guest.admit', guestId: invitation.guestId });
  assert.equal(result.statusCode, 503, result.body);
  assert.equal(result.json().code, 'OBS_CONFIRMATION_LOST');
  assert.equal(slot(await ctx.state(), ctx.project.id, invitation.guestId).admitted, false);
  assert.equal(ctx.obs.state.inputs.find(input => input.name === ctx.app.guests.getGuest(invitation.guestId).inputName)?.muted, true);
  connected.guest.close(); connected.bridge.close();
});

test('a bridge lease reserves its production before camera permissions or WebSocket connection complete', async t => {
  const ctx = await fixture(t);
  const other: Project = (await ctx.app.inject({ method: 'POST', url: '/api/projects', headers: headers(ctx.pc), payload: { title: 'Autre production', format: 'podcast', defaultScene: 'Podcast',
    participants: [{ id: 'local-b', name: 'Camille', micInput: 'Micro salle', sceneName: 'Podcast' }] } })).json();
  const grant = await ctx.app.inject({ method: 'POST', url: `/api/projects/${ctx.project.id}/guests/bridge-session`, headers: headers(ctx.pc), payload: {} });
  assert.equal(grant.statusCode, 200);
  assert.equal((await ctx.state()).guestRooms?.[ctx.project.id]?.bridge.connected, false, 'the PC is still waiting on browser permissions');
  for (const action of ['record.start', 'stream.start'] as const) {
    const result = await ctx.control(ctx.ipad, { action, projectId: other.id });
    assert.equal(result.statusCode, 409, result.body); assert.equal(result.json().code, 'GUEST_PROJECT_CONFLICT');
  }
  assert.equal(ctx.obs.recordStarts, 0); assert.equal(ctx.obs.liveStarts, 0);
  assert.equal((await ctx.control(ctx.deck, { action: 'guest.bridge.stop', projectId: ctx.project.id })).statusCode, 200);
  assert.equal(ctx.app.guests.bridgeProjectId(), null);
});

test('preparation renews an unusable source grant but preserves an active source while reinviting the same slot', async t => {
  const ctx = await fixture(t); const invitation = await ctx.invite();
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.prepare', projectId: ctx.project.id })).statusCode, 200);
  const firstUrl = ctx.obs.lastSources[0].url;
  ctx.app.guests.claimSource(tokenFrom(firstUrl)); // grant claimed without a live OBS socket
  assert.equal(ctx.app.guests.hasSourceAccess(invitation.guestId), false);
  assert.equal((await ctx.control(ctx.deck, { action: 'guest.prepare', projectId: ctx.project.id })).statusCode, 200);
  const secondUrl = ctx.obs.lastSources[0].url;
  assert.notEqual(secondUrl, firstUrl, 'do not reuse a consumed URL before its five-minute expiry');
  const sourceSession = ctx.app.guests.claimSource(tokenFrom(secondUrl));
  const source = await peer(ctx.base, sourceSession); t.after(() => source.close());
  assert.equal(ctx.app.guests.hasSourceAccess(invitation.guestId), true);
  const nextInvitation = await ctx.invite(1, ctx.deck);
  assert.equal(nextInvitation.guestId, invitation.guestId);
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.prepare', projectId: ctx.project.id })).statusCode, 200);
  assert.equal(ctx.obs.lastSources[0].url, secondUrl, 'a live source survives a new guest invitation without a browser reload');
  assert.equal((await ctx.app.inject({ method: 'DELETE', url: `/api/devices/${ctx.deck.device.id}`, headers: headers(ctx.pc) })).statusCode, 204);
  assert.equal(ctx.app.guests.hasSourceAccess(invitation.guestId), false);
  await ctx.invite();
  assert.equal((await ctx.control(ctx.pc, { action: 'guest.prepare', projectId: ctx.project.id })).statusCode, 200);
  assert.notEqual(ctx.obs.lastSources[0].url, secondUrl, 'a revoked source owner requires a new grant');
});
