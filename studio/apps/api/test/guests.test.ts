import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import type { GuestServerMessage, GuestSession, Project } from '@gabin/shared';
import { Store } from '../src/store.js';
import { GuestService, type GuestConfig } from '../src/guests.js';
import { buildGuestApp } from '../src/guest-app.js';

const project = (id: string): Project => ({ id, title: `Production ${id}`, description: '', owner: '', format: 'podcast', participants: [], defaultScene: null,
  status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const fragment = (url: string): string => new URL(url).hash.split('/').at(-1)!;

async function fixture(t: TestContext, config: GuestConfig = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nino-guests-'));
  const store = new Store(dir); store.put('project', project('a')); store.put('project', project('b'));
  const owner = store.createDevice('PC', 'pc', 'technician');
  const viewer = store.createDevice('Lecture', 'pc', 'viewer');
  const ipad = store.createDevice('iPad', 'ipad', 'operator');
  const guests = new GuestService(store, config);
  const app = await buildGuestApp({ guests });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { guests.close(); await app.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, owner, viewer, ipad, guests, app, base };
}

class Peer {
  readonly messages: GuestServerMessage[] = [];
  constructor(readonly socket: WebSocket) { socket.on('message', raw => this.messages.push(JSON.parse(raw.toString()))); socket.on('error', () => undefined); }
  async message(type: GuestServerMessage['type']): Promise<GuestServerMessage> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(message => message.type === type);
      if (index >= 0) return this.messages.splice(index, 1)[0]!;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`Missing ${type} message`);
  }
  send(data: unknown): void { this.socket.send(JSON.stringify(data)); }
  async close(): Promise<void> { if (this.socket.readyState < 2) { const close = once(this.socket, 'close'); this.socket.close(); await close; } }
}
async function connect(base: string, session: GuestSession, origin?: string, socketOptions: { autoPong?: boolean } = {}): Promise<Peer> {
  const peer = new Peer(new WebSocket(`${base.replace(/^http/, 'ws')}/api/guest/events`, { ...socketOptions, ...(origin ? { origin } : {}) }));
  await once(peer.socket, 'open');
  peer.send({ type: 'auth', token: session.token });
  const welcome = await peer.message('welcome');
  assert.equal(welcome.type, 'welcome');
  if (welcome.type === 'welcome') assert.equal(welcome.peer.id, session.peerId);
  return peer;
}
async function report(peer: Peer, data: unknown): Promise<void> {
  peer.messages.length = 0; peer.send(data); await peer.message('room');
}

test('one-use invitations are bounded to two slots, never store bearer tokens and survive restart without grants', async t => {
  const { guests, store, owner, viewer, dir } = await fixture(t);
  assert.throws(() => guests.invite('a', 3 as 1, 'Invalid', owner.device.id), { statusCode: 400 });
  assert.throws(() => guests.invite('a', 1, 'Alice', viewer.device.id), { statusCode: 401 });
  assert.throws(() => guests.invite('missing', 1, 'Alice', owner.device.id), { statusCode: 404 });
  const invitation = guests.invite('a', 1, 'Alice', owner.device.id);
  assert.equal(new URL(invitation.url).search, '');
  assert.match(invitation.url, /#guest\/[a-zA-Z0-9_-]{43}$/);
  const token = fragment(invitation.url);
  assert.deepEqual(guests.inspectInvitation(token), { guestId: invitation.guestId, name: 'Alice', title: 'Production a', slot: 1, expiresAt: invitation.expiresAt, available: true });
  assert.throws(() => guests.join(token, ''), { statusCode: 400 });
  const session = guests.join(token, 'Alice Confirmée');
  assert.equal(session.role, 'guest'); assert.equal(session.projectId, 'a');
  assert.throws(() => guests.join(token, 'Alice'), { statusCode: 401 });
  assert.equal((await readFile(path.join(dir, 'studio.sqlite'))).includes(Buffer.from(token)), false);
  assert.equal((await readFile(path.join(dir, 'studio.sqlite'))).includes(Buffer.from(session.token)), false);
  const replacement = guests.invite('a', 1, 'Bob', owner.device.id);
  assert.equal(replacement.guestId, invitation.guestId);
  assert.equal(guests.rooms().a!.guests.length, 1);
  assert.throws(() => guests.resume(session.token), { statusCode: 401 });
  guests.invite('a', 2, 'Charlie', owner.device.id);
  guests.close();
  const restarted = new GuestService(store, {});
  t.after(() => restarted.close());
  assert.equal(restarted.rooms().a!.bridge.connected, false);
  assert.equal(restarted.rooms().a!.guests.some(guest => guest.admitted || guest.mediaReady || guest.sourceReady), false);
  assert.equal(restarted.inspectInvitation(fragment(replacement.url)).name, 'Bob');
});

test('expiry, owner revocation, local source tickets and TURN credentials use scoped ephemeral grants', async t => {
  let now = Date.now();
  const config = { now: () => now, publicUrl: 'https://call.nino.example', stunUrls: ['stun:stun.nino.example:3478'], turnUrls: ['turns:turn.nino.example:5349?transport=tcp'], turnSecret: 'temporary-test-secret-32' };
  const { guests, owner, ipad, store } = await fixture(t, config);
  assert.throws(() => new GuestService(store, { publicUrl: 'http://remote.example' }), /HTTPS/);
  assert.throws(() => new GuestService(store, { turnUrls: ['turn:relay.example:3478'] }), /TURN/);
  const invite = guests.invite('a', 1, 'Alice', owner.device.id);
  assert.match(invite.url, /^https:\/\/call.nino.example\/#guest\//);
  const session = guests.join(fragment(invite.url), 'Alice');
  assert.match(session.socketPath, /^wss:\/\/call.nino.example\/api\/guest\/events$/);
  const relay = session.iceServers[1]!;
  assert.equal(relay.credential, createHmac('sha1', config.turnSecret).update(relay.username!).digest('base64'));
  assert.equal(JSON.stringify(session).includes(config.turnSecret), false);
  assert.throws(() => guests.bridgeSession('a', ipad.device.id), { statusCode: 403 });
  const bridge = guests.bridgeSession('a', owner.device.id);
  assert.throws(() => guests.bridgeSession('b', owner.device.id), { statusCode: 409 });
  const ticket = guests.sourceTicket(invite.guestId, ipad.device.id);
  assert.match(ticket.url, /^http:\/\/127\.0\.0\.1:4312\/#guest-source\//);
  const source = guests.claimSource(fragment(ticket.url));
  assert.equal(source.role, 'source'); assert.match(source.socketPath, /^ws:\/\/127\.0\.0\.1:4312\//);
  assert.throws(() => guests.claimSource(fragment(ticket.url)), { statusCode: 401 });
  const expiringTicket = guests.sourceTicket(invite.guestId, owner.device.id);
  now += 5 * 60_000 + 1;
  assert.throws(() => guests.claimSource(fragment(expiringTicket.url)), { statusCode: 401 });
  now += 6 * 3600_000;
  assert.throws(() => guests.resume(session.token), { statusCode: 401 });
  assert.throws(() => guests.resume(bridge.token), { statusCode: 401 });
  const expiringInvite = guests.invite('b', 1, 'Bob', owner.device.id);
  now += 24 * 3600_000 + 1;
  assert.throws(() => guests.inspectInvitation(fragment(expiringInvite.url)), { statusCode: 401 });
  const revocable = guests.invite('a', 1, 'Charles', owner.device.id);
  const revocableSession = guests.join(fragment(revocable.url), 'Charles');
  store.revoke(owner.device.id); guests.revokeDevice(owner.device.id);
  assert.throws(() => guests.resume(revocableSession.token), { statusCode: 401 });
});

test('public listener blocks all administrative APIs even on loopback and rejects cross-origin or URL credentials', async t => {
  const { app, guests, owner } = await fixture(t);
  for (const url of ['/api/auth/local', '/api/state', '/api/control', '/api/room', '/api/devices', '/api/monitor/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.m3u8']) {
    const result = await app.inject({ method: url === '/api/auth/local' || url === '/api/control' ? 'POST' : 'GET', url, headers: { host: 'localhost:4312', authorization: `Bearer ${owner.token}` }, payload: url === '/api/control' ? { action: 'record.stop' } : undefined });
    assert.equal(result.statusCode, 404, url);
  }
  const info = await app.inject({ url: '/api/guest/config' }); assert.equal(info.json().mode, 'guest');
  assert.match(String(info.headers['permissions-policy']), /camera=\(self\)/);
  const invite = guests.invite('a', 1, 'Alice', owner.device.id);
  const payload = { token: fragment(invite.url) };
  assert.equal((await app.inject({ method: 'POST', url: '/api/guest/invitation', headers: { origin: 'https://evil.example', host: 'localhost:4312' }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/guest/invitation?token=secret', payload })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/guest/invitation', payload: { ...payload, action: 'record.start' } })).statusCode, 400);
  const ticket = guests.sourceTicket(invite.guestId, owner.device.id);
  assert.equal((await app.inject({ method: 'POST', url: '/api/guest/source', headers: { host: 'public.example' }, payload: { token: fragment(ticket.url) } })).statusCode, 403);
  const local = await app.inject({ method: 'POST', url: '/api/guest/source', headers: { host: '127.0.0.1:4312' }, payload: { token: fragment(ticket.url) } });
  assert.equal(local.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/guest/resume', headers: { host: 'public.example' }, payload: { token: local.json().token } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/guest/join', payload: { token: 'x'.repeat(10_000), name: 'Alice' } })).statusCode, 413);
});

test('WebRTC signaling is limited to the bridge and its project, with decoded media required for admission', async t => {
  const { guests, owner, base } = await fixture(t);
  const a1 = guests.invite('a', 1, 'Alice', owner.device.id);
  const a2 = guests.invite('a', 2, 'Bob', owner.device.id);
  const other = guests.invite('b', 1, 'Outside', owner.device.id);
  assert.notEqual(guests.getGuest(a1.guestId).inputName, guests.getGuest(other.guestId).inputName, 'OBS names bind each project separately');
  const bridgeSession = guests.bridgeSession('a', owner.device.id);
  const aliceSession = guests.join(fragment(a1.url), 'Alice');
  const bobSession = guests.join(fragment(a2.url), 'Bob');
  const outsideSession = guests.join(fragment(other.url), 'Outside');
  const sourceSession = guests.claimSource(fragment(guests.sourceTicket(a1.guestId, owner.device.id).url));
  const bridge = await connect(base, bridgeSession);
  const alice = await connect(base, aliceSession);
  const bob = await connect(base, bobSession);
  const outside = await connect(base, outsideSession);
  const source = await connect(base, sourceSession);
  assert.throws(() => guests.admit(a1.guestId), { statusCode: 409 });
  const offerSdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ssrc:23517146 cname:nino\r\n';
  alice.send({ type: 'signal', to: bridgeSession.peerId, description: { type: 'offer', sdp: offerSdp } });
  const signal = await bridge.message('signal');
  assert.equal(signal.type, 'signal');
  if (signal.type === 'signal') {
    assert.equal(signal.from.id, aliceSession.peerId); assert.equal(signal.description?.type, 'offer');
    assert.equal(signal.description.sdp, offerSdp, 'WebRTC SDP is relayed byte-for-byte, including its required final CRLF');
  }
  bridge.send({ type: 'signal', to: sourceSession.peerId, candidate: null });
  const toSource = await source.message('signal'); assert.equal(toSource.type, 'signal');
  await report(bridge, { type: 'media', ready: true, video: true, audio: true });
  await report(bridge, { type: 'media', guestId: a1.guestId, ready: true, video: true, audio: false });
  assert.equal(guests.getGuest(a1.guestId).mediaReady, false);
  assert.throws(() => guests.admit(a1.guestId), { statusCode: 409 });
  await report(bridge, { type: 'media', guestId: a1.guestId, ready: true, video: true, audio: true });
  assert.equal(guests.getGuest(a1.guestId).status, 'ready', 'ready means eligible for admission; source reception follows admission');
  guests.admit(a1.guestId);
  assert.equal(guests.getGuest(a1.guestId).admitted, true);
  assert.equal(guests.getGuest(a1.guestId).sourceReady, false, 'source readiness is independent of admission, avoiding a forwarding cycle');
  await report(source, { type: 'media', guestId: a1.guestId, ready: true, video: true, audio: true });
  assert.equal(guests.getGuest(a1.guestId).sourceReady, true);
  guests.setMuted(a1.guestId, true); assert.equal(guests.getGuest(a1.guestId).muted, true);
  alice.send({ type: 'signal', to: bobSession.peerId, candidate: null });
  assert.match((await alice.message('error') as { error: string }).error, /autorisé/);
  outside.send({ type: 'signal', to: bridgeSession.peerId, candidate: null });
  assert.match((await outside.message('error') as { error: string }).error, /autorisé/);
  await alice.close(); await bob.close(); await outside.close(); await source.close(); await bridge.close();
});

test('guests cannot forge media-ready, duplicate sockets cannot steal a session, and disconnect suspends admission', async t => {
  const { guests, owner, base } = await fixture(t);
  const invite = guests.invite('a', 1, 'Alice', owner.device.id);
  const session = guests.join(fragment(invite.url), 'Alice');
  const bridgeSession = guests.bridgeSession('a', owner.device.id);
  const bridge = await connect(base, bridgeSession);
  const guest = await connect(base, session);
  const duplicate = new Peer(new WebSocket(`${base.replace(/^http/, 'ws')}/api/guest/events`));
  await once(duplicate.socket, 'open'); duplicate.send({ type: 'auth', token: session.token });
  assert.match((await duplicate.message('error') as { error: string }).error, /déjà connectée/);
  assert.equal(guests.getGuest(invite.guestId).joined, true);
  await report(bridge, { type: 'media', ready: true, video: true, audio: true });
  await report(bridge, { type: 'media', guestId: invite.guestId, ready: true, video: true, audio: true });
  guests.admit(invite.guestId);
  guest.messages.length = 0;
  await bridge.close();
  let disconnected = await guest.message('room');
  while (disconnected.type === 'room' && disconnected.room.bridge.connected) disconnected = await guest.message('room');
  assert.equal(guests.getGuest(invite.guestId).admitted, false);
  assert.equal(guests.getGuest(invite.guestId).muted, true);
  const resumedBridge = await connect(base, guests.resume(bridgeSession.token));
  assert.equal(guests.rooms().a!.bridge.mediaReady, false);
  guest.send({ type: 'media', guestId: invite.guestId, ready: true, video: true, audio: true });
  assert.match((await guest.message('error') as { error: string }).error, /réception dans la salle/);
  await guest.close(); await duplicate.close(); await resumedBridge.close();
});

test('source role can report only its own guest; bridge leave and revocation stop all active grants', async t => {
  const { guests, owner, base, store } = await fixture(t);
  const a1 = guests.invite('a', 1, 'Alice', owner.device.id);
  const a2 = guests.invite('a', 2, 'Bob', owner.device.id);
  guests.join(fragment(a1.url), 'Alice');
  const bridgeSession = guests.bridgeSession('a', owner.device.id);
  const bridge = await connect(base, bridgeSession);
  const sourceSession = guests.claimSource(fragment(guests.sourceTicket(a1.guestId, owner.device.id).url));
  const source = await connect(base, sourceSession);
  source.send({ type: 'media', guestId: a2.guestId, ready: true, video: true, audio: true });
  assert.match((await source.message('error') as { error: string }).error, /autorisé/);
  bridge.send({ type: 'leave' }); await once(bridge.socket, 'close');
  assert.throws(() => guests.resume(bridgeSession.token), { statusCode: 401 });
  const replacementBridge = guests.bridgeSession('b', owner.device.id);
  const replacement = await connect(base, replacementBridge);
  store.revoke(owner.device.id); guests.revokeDevice(owner.device.id);
  assert.equal(guests.rooms().b!.bridge.connected, false);
  assert.throws(() => guests.resume(replacementBridge.token), { statusCode: 401 });
  await source.close(); await replacement.close();
});

test('socket rate limit and first-message authentication reject abusive signaling before any grant', async t => {
  const { guests, owner, base } = await fixture(t);
  const noAuth = new Peer(new WebSocket(`${base.replace(/^http/, 'ws')}/api/guest/events`));
  await once(noAuth.socket, 'open'); noAuth.send({ type: 'signal', to: 'missing', candidate: null });
  assert.match((await noAuth.message('error') as { error: string }).error, /Authentification/);
  const invitation = guests.invite('a', 1, 'Alice', owner.device.id);
  const bridgeSession = guests.bridgeSession('a', owner.device.id);
  const guestSession = guests.join(fragment(invitation.url), 'Alice');
  const bridge = await connect(base, bridgeSession);
  const guest = await connect(base, guestSession);
  for (let index = 0; index < 305; index++) guest.send({ type: 'signal', to: bridgeSession.peerId, candidate: null });
  assert.match((await guest.message('error') as { error: string }).error, /Trop de messages/);
  await guest.close(); await bridge.close(); await noAuth.close();
});

test('admission rechecks live session expiry immediately instead of waiting for the heartbeat sweep', async t => {
  let now = Date.now();
  const { guests, owner, base } = await fixture(t, { now: () => now });
  const invitation = guests.invite('a', 1, 'Alice', owner.device.id);
  const guestSession = guests.join(fragment(invitation.url), 'Alice');
  const bridgeSession = guests.bridgeSession('a', owner.device.id);
  const bridge = await connect(base, bridgeSession);
  const guest = await connect(base, guestSession);
  await report(bridge, { type: 'media', ready: true, video: true, audio: true });
  await report(bridge, { type: 'media', guestId: invitation.guestId, ready: true, video: true, audio: true });
  now += 6 * 3600_000 + 1;
  assert.throws(() => guests.admit(invitation.guestId), { statusCode: 409 });
  assert.equal(guests.getGuest(invitation.guestId).admitted, false);
  assert.equal(guests.getGuest(invitation.guestId).muted, true);
  await guest.close(); await bridge.close();
});

test('local source and bridge credentials cannot authenticate through the public WebSocket host', async t => {
  const { guests, owner, base } = await fixture(t);
  const invitation = guests.invite('a', 1, 'Alice', owner.device.id);
  const source = guests.claimSource(fragment(guests.sourceTicket(invitation.guestId, owner.device.id).url));
  const bridge = guests.bridgeSession('a', owner.device.id);
  for (const session of [source, bridge]) {
    const peer = new Peer(new WebSocket(`${base.replace(/^http/, 'ws')}/api/guest/events`, { headers: { Host: 'public.example' } }));
    await once(peer.socket, 'open'); peer.send({ type: 'auth', token: session.token });
    assert.match((await peer.message('error') as { error: string }).error, /réservé/);
    await peer.close();
  }
  assert.equal(guests.rooms().a!.bridge.connected, false);
  assert.equal(guests.getGuest(invitation.guestId).sourceReady, false);
});

test('late bridge media for a removed guest leaves the bridge and the second guest active', async t => {
  const { guests, owner, base } = await fixture(t);
  const first = guests.invite('a', 1, 'Alice', owner.device.id);
  const second = guests.invite('a', 2, 'Bob', owner.device.id);
  const bridgeSession = guests.bridgeSession('a', owner.device.id);
  const firstSession = guests.join(fragment(first.url), 'Alice');
  const secondSession = guests.join(fragment(second.url), 'Bob');
  const bridge = await connect(base, bridgeSession);
  const alice = await connect(base, firstSession);
  const bob = await connect(base, secondSession);
  await report(bridge, { type: 'media', ready: true, video: true, audio: true });
  for (const id of [first.guestId, second.guestId]) {
    await report(bridge, { type: 'media', guestId: id, ready: true, video: true, audio: true });
    guests.admit(id);
  }
  const aliceClosed = once(alice.socket, 'close');
  guests.remove(first.guestId);
  assert.equal((await aliceClosed)[0], 4001, 'removal revokes the original grant');
  const removed = guests.rooms().a!.guests.find(guest => guest.id === first.guestId)!;
  const remaining = guests.getGuest(second.guestId);
  bridge.messages.length = 0; bob.messages.length = 0;
  // RTC callbacks may already be queued when the controller removes a guest.
  for (const ready of [false, true]) bridge.send({ type: 'media', guestId: first.guestId, ready, video: true, audio: true });
  // A later message on the same ordered WebSocket is the processing barrier.
  bridge.send({ type: 'signal', to: secondSession.peerId, candidate: null });
  assert.equal((await bob.message('signal')).type, 'signal');
  assert.equal(bridge.socket.readyState, WebSocket.OPEN);
  assert.equal(bridge.messages.some(message => message.type === 'error'), false);
  assert.equal(guests.rooms().a!.bridge.connected, true);
  assert.deepEqual(guests.getGuest(second.guestId), remaining);
  assert.deepEqual(guests.rooms().a!.guests.find(guest => guest.id === first.guestId), removed);
  assert.equal(removed.status, 'removed');
  assert.equal(removed.admitted || removed.joined || removed.mediaReady || removed.sourceReady, false);
  assert.equal(removed.muted, true);
  assert.throws(() => guests.resume(firstSession.token), { statusCode: 401 });
  await bob.close(); await bridge.close();
});

test('late signaling to known revoked guest and source peers leaves the remaining guest active', async t => {
  const { guests, owner, base } = await fixture(t);
  const first = guests.invite('a', 1, 'Alice', owner.device.id);
  const second = guests.invite('a', 2, 'Bob', owner.device.id);
  const bridgeSession = guests.bridgeSession('a', owner.device.id);
  const firstSession = guests.join(fragment(first.url), 'Alice');
  const secondSession = guests.join(fragment(second.url), 'Bob');
  const sourceSession = guests.claimSource(fragment(guests.sourceTicket(first.guestId, owner.device.id).url));
  const bridge = await connect(base, bridgeSession);
  const alice = await connect(base, firstSession);
  const bob = await connect(base, secondSession);
  const source = await connect(base, sourceSession);
  await report(bridge, { type: 'media', ready: true, video: true, audio: true });
  await report(bridge, { type: 'media', guestId: second.guestId, ready: true, video: true, audio: true });
  guests.admit(second.guestId);
  const aliceClosed = once(alice.socket, 'close');
  const sourceClosed = once(source.socket, 'close');
  guests.remove(first.guestId);
  await Promise.all([aliceClosed, sourceClosed]);
  const remaining = guests.getGuest(second.guestId);
  bridge.messages.length = 0; bob.messages.length = 0;
  for (const to of [firstSession.peerId, sourceSession.peerId]) bridge.send({ type: 'signal', to, candidate: null });
  bridge.send({ type: 'signal', to: secondSession.peerId, candidate: null });
  assert.equal((await bob.message('signal')).type, 'signal');
  assert.equal(bridge.socket.readyState, WebSocket.OPEN);
  assert.equal(bridge.messages.some(message => message.type === 'error'), false);
  assert.deepEqual(guests.getGuest(second.guestId), remaining);
  assert.equal(guests.rooms().a!.guests.find(guest => guest.id === first.guestId)!.status, 'removed');
  await bob.close(); await bridge.close();
});

test('late-message tolerance never authorizes unknown guests or foreign project media and peers', async t => {
  for (const kind of ['unknown-media', 'foreign-media', 'foreign-removed-media', 'unknown-signal', 'foreign-revoked-signal', 'guest-to-revoked-guest'] as const) {
    await t.test(kind, async sub => {
      const { guests, owner, base } = await fixture(sub);
      const first = guests.invite('a', 1, 'Alice', owner.device.id);
      const second = guests.invite('a', 2, 'Bob', owner.device.id);
      const foreign = guests.invite('b', 1, 'Outside', owner.device.id);
      const bridgeSession = guests.bridgeSession('a', owner.device.id);
      const firstSession = guests.join(fragment(first.url), 'Alice');
      const secondSession = guests.join(fragment(second.url), 'Bob');
      const foreignSession = guests.join(fragment(foreign.url), 'Outside');
      const bridge = await connect(base, bridgeSession);
      const alice = await connect(base, firstSession);
      const bob = await connect(base, secondSession);
      const outside = await connect(base, foreignSession);
      if (kind === 'foreign-removed-media' || kind === 'foreign-revoked-signal') {
        const closed = once(outside.socket, 'close'); guests.remove(foreign.guestId); await closed;
      }
      if (kind === 'guest-to-revoked-guest') {
        const closed = once(alice.socket, 'close'); guests.remove(first.guestId); await closed;
      }
      const sender = kind === 'guest-to-revoked-guest' ? bob : bridge;
      const closed = once(sender.socket, 'close');
      sender.send(kind.endsWith('media')
        ? { type: 'media', guestId: kind === 'unknown-media' ? 'unknown-guest' : foreign.guestId, ready: true, video: true, audio: true }
        : { type: 'signal', to: kind === 'unknown-signal' ? 'unknown-peer' : kind === 'guest-to-revoked-guest' ? firstSession.peerId : foreignSession.peerId, candidate: null });
      assert.equal((await sender.message('error')).type, 'error');
      assert.equal((await closed)[0], 4003);
      assert.equal(guests.getGuest(second.guestId).admitted, false);
      await alice.close(); await bob.close(); await outside.close(); await bridge.close();
    });
  }
});

test('heartbeat interruption uses a resumable close without restoring admission; revocation stays final', async t => {
  const { guests, owner, base } = await fixture(t);
  const invitation = guests.invite('a', 1, 'Alice', owner.device.id);
  const guestSession = guests.join(fragment(invitation.url), 'Alice');
  const bridgeSession = guests.bridgeSession('a', owner.device.id);
  const bridge = await connect(base, bridgeSession, undefined, { autoPong: false });
  const guest = await connect(base, guestSession);
  await report(bridge, { type: 'media', ready: true, video: true, audio: true });
  await report(bridge, { type: 'media', guestId: invitation.guestId, ready: true, video: true, audio: true });
  guests.admit(invitation.guestId);
  // Drive the unchanged heartbeat callback directly, with a real socket that
  // deliberately withholds pong. The other socket must remain responsive.
  const sweep = (guests as unknown as { sweep(heartbeat: boolean): void }).sweep.bind(guests);
  const ping = once(guest.socket, 'ping');
  sweep(true); await ping;
  guest.send({ type: 'signal', to: bridgeSession.peerId, candidate: null });
  await bridge.message('signal'); // The preceding pong on this socket was processed.
  const interrupted = once(bridge.socket, 'close');
  sweep(true);
  assert.equal((await interrupted)[0], 4000, 'temporary transport loss must not be reported as a revoked grant');
  assert.equal(guests.getGuest(invitation.guestId).admitted, false);
  assert.equal(guests.getGuest(invitation.guestId).muted, true);
  const resumed = guests.resume(bridgeSession.token);
  assert.equal(resumed.token, bridgeSession.token);
  assert.equal(resumed.peerId, bridgeSession.peerId);
  assert.equal(resumed.expiresAt, bridgeSession.expiresAt, 'reconnection never renews the grant');
  const replacement = await connect(base, resumed);
  assert.equal(guests.rooms().a!.bridge.connected, true);
  assert.equal(guests.rooms().a!.bridge.mediaReady, false);
  assert.equal(guests.getGuest(invitation.guestId).joined, true);
  assert.equal(guests.getGuest(invitation.guestId).admitted, false);
  const revoked = once(replacement.socket, 'close');
  guests.stopBridge('a');
  assert.equal((await revoked)[0], 4001);
  assert.throws(() => guests.resume(bridgeSession.token), { statusCode: 401 });
  await guest.close();
});

test('retired peer tolerance expires and still validates WebRTC payloads', async t => {
  for (const kind of ['expired', 'malformed'] as const) {
    await t.test(kind, async sub => {
      let now = Date.now();
      const { guests, owner, base } = await fixture(sub, { now: () => now });
      const invitation = guests.invite('a', 1, 'Alice', owner.device.id);
      const guestSession = guests.join(fragment(invitation.url), 'Alice');
      const bridgeSession = guests.bridgeSession('a', owner.device.id);
      const bridge = await connect(base, bridgeSession);
      const guest = await connect(base, guestSession);
      const removed = once(guest.socket, 'close');
      guests.remove(invitation.guestId); await removed;
      if (kind === 'expired') now += 30_001;
      const closed = once(bridge.socket, 'close');
      bridge.send({ type: 'signal', to: guestSession.peerId, candidate: kind === 'expired' ? null : { candidate: 25 } });
      const error = await bridge.message('error');
      assert.equal(error.type, 'error');
      if (error.type === 'error') assert.match(error.error, kind === 'expired' ? /autorisé/ : /candidat WebRTC/);
      assert.equal((await closed)[0], 4003);
      const slot = guests.rooms().a!.guests.find(candidate => candidate.id === invitation.guestId)!;
      assert.equal(slot.status, 'removed');
      assert.equal(slot.admitted || slot.mediaReady || slot.sourceReady || slot.joined, false);
      assert.throws(() => guests.resume(guestSession.token), { statusCode: 401 });
    });
  }
});
