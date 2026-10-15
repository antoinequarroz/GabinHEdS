import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import type { GuestSession, Project } from '@gabin/shared';
import { Store } from '../src/store.js';
import { GuestService, type GuestConfig } from '../src/guests.js';
import { buildGuestApp } from '../src/guest-app.js';

const publicHost = 'call.nino.example';
const publicUrl = `https://${publicHost}`;
const ipA = '198.51.100.18';
const ipB = '203.0.113.24';
const tokenFragment = (url: string): string => new URL(url).hash.split('/').at(-1)!;
const headers = (ip: string) => ({ host: publicHost, 'x-forwarded-for': ip, 'x-nino-client-ip': ip });

async function fixture(t: TestContext, config: GuestConfig) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nino-guest-proxy-'));
  const store = new Store(directory);
  const project: Project = { id: 'proxy-room', title: 'Proxy fixture', owner: '', description: '', format: 'podcast', participants: [], defaultScene: null,
    status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.put('project', project);
  const owner = store.createDevice('Local PC fixture', 'pc', 'technician');
  const guests = new GuestService(store, { publicUrl, ...config });
  const app = await buildGuestApp({ guests });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    guests.close(); await app.close(); store.close(); await rm(directory, { recursive: true, force: true });
  });
  async function open(socketHeaders: Record<string, string> = {}) {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/guest/events`, { headers: socketHeaders });
    sockets.add(socket);
    const messages: Record<string, unknown>[] = [];
    socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
    socket.on('error', () => undefined);
    const closed = new Promise<{ code: number }>(resolve => socket.once('close', code => resolve({ code })));
    await once(socket, 'open');
    async function message(type: string) {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(value => value.type === type);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail(`Missing ${type} response from guest gateway`);
    }
    return { socket, closed, message };
  }
  async function connect(session: GuestSession, socketHeaders: Record<string, string> = {}) {
    const peer = await open(socketHeaders);
    peer.socket.send(JSON.stringify({ type: 'auth', token: session.token }));
    const welcome = await peer.message('welcome');
    assert.equal((welcome.peer as { id: string }).id, session.peerId);
    return peer;
  }
  return { app, guests, owner, project, open, connect };
}

test('trusted proxy isolates anonymous socket and HTTP floods from another guest and local OBS peers', { timeout: 10_000 }, async t => {
  const { app, guests, owner, project, open, connect } = await fixture(t, { trustLocalProxy: true });
  const invitation = guests.invite(project.id, 1, 'Alice fixture', owner.device.id);
  const waitingSession = guests.join(tokenFragment(invitation.url), 'Alice fixture');
  const secondInvitation = guests.invite(project.id, 2, 'Bob fixture', owner.device.id);
  // All sockets physically arrive on 127.0.0.1, just like the local reverse
  // tunnel. Anonymous client A fills its own allowance, not the proxy's pool.
  const pending = [];
  for (let index = 0; index < 16; index++) pending.push(await open(headers(ipA)));
  const overflow = await open(headers(ipA));
  assert.equal((await overflow.closed).code, 4008);
  assert.equal(pending.every(peer => peer.socket.readyState === WebSocket.OPEN), true);

  const guest = await connect(waitingSession, headers(ipB));
  const bridge = await connect(guests.bridgeSession(project.id, owner.device.id));
  const ticket = guests.sourceTicket(invitation.guestId, owner.device.id);
  const source = await connect(guests.claimSource(tokenFragment(ticket.url)));
  assert.equal(guest.socket.readyState, WebSocket.OPEN);
  assert.equal(bridge.socket.readyState, WebSocket.OPEN);
  assert.equal(source.socket.readyState, WebSocket.OPEN);

  // Exercise the real route limiter, not a key helper. Invalid invitations
  // still consume A's quota; a valid invitation from B remains readable.
  let limited = false;
  for (let attempt = 0; attempt < 65; attempt++) {
    const response = await app.inject({ method: 'POST', url: '/api/guest/invitation', headers: headers(ipA), payload: { token: 'A'.repeat(43) } });
    if (response.statusCode === 429) { limited = true; break; }
    assert.equal(response.statusCode, 401);
  }
  assert.equal(limited, true, 'anonymous client A reaches its HTTP quota');
  const healthy = await app.inject({ method: 'POST', url: '/api/guest/invitation', headers: headers(ipB), payload: { token: tokenFragment(secondInvitation.url) } });
  assert.equal(healthy.statusCode, 200);
  assert.equal(healthy.json().name, 'Bob fixture');
  const local = await app.inject({ url: '/api/guest/config', headers: { host: '127.0.0.1:4312' } });
  assert.equal(local.statusCode, 200);
});

test('forwarded client identity requires opt-in, canonical public host, loopback peer and one valid IP without granting source privileges', { timeout: 15_000 }, async t => {
  const cases = [
    { label: 'proxy trust disabled', trusted: false, host: publicHost, remoteAddress: '127.0.0.1', forged: (index: number) => `198.51.100.${index + 1}` },
    { label: 'private Host cannot use public identity', trusted: true, host: '127.0.0.1:4312', remoteAddress: '127.0.0.1', forged: (index: number) => `198.51.100.${index + 1}` },
    { label: 'external peer cannot claim trusted proxy identity', trusted: true, host: publicHost, remoteAddress: '203.0.113.81', forged: (index: number) => `198.51.100.${index + 1}` },
    { label: 'a list of IPs is not a trusted client', trusted: true, host: publicHost, remoteAddress: '127.0.0.1', forged: (index: number) => `198.51.100.${index + 1}, 203.0.113.1` },
  ];
  for (const scenario of cases) {
    const { app } = await fixture(t, { trustLocalProxy: scenario.trusted });
    let limited = false;
    for (let attempt = 0; attempt < 65; attempt++) {
      const response = await app.inject({ method: 'POST', url: '/api/guest/invitation', remoteAddress: scenario.remoteAddress,
        headers: { host: scenario.host, 'x-forwarded-for': ipA, 'x-nino-client-ip': scenario.forged(attempt) }, payload: { token: 'A'.repeat(43) } });
      if (response.statusCode === 429) { limited = true; break; }
      assert.equal(response.statusCode, 401, scenario.label);
    }
    assert.equal(limited, true, `${scenario.label}: rotating untrusted headers cannot bypass the quota`);
  }

  const { app, guests, owner, project, open } = await fixture(t, { trustLocalProxy: true });
  const invitation = guests.invite(project.id, 1, 'Source fixture', owner.device.id);
  const ticket = guests.sourceTicket(invitation.guestId, owner.device.id);
  const claim = await app.inject({ method: 'POST', url: '/api/guest/source', headers: headers(ipB), payload: { token: tokenFragment(ticket.url) } });
  assert.equal(claim.statusCode, 403, 'trusted rate-limit identity never grants local-source access');
  const source = guests.claimSource(tokenFragment(ticket.url));
  const bridge = guests.bridgeSession(project.id, owner.device.id);
  for (const session of [source, bridge]) {
    const peer = await open(headers(ipB));
    peer.socket.send(JSON.stringify({ type: 'auth', token: session.token }));
    assert.match(String((await peer.message('error')).error), /réservé/);
    assert.equal((await peer.closed).code, 4003);
    const resume = await app.inject({ method: 'POST', url: '/api/guest/resume', headers: headers(ipB), payload: { token: session.token } });
    assert.equal(resume.statusCode, 403);
  }
  assert.equal(guests.rooms()[project.id]!.bridge.connected, false);
  assert.equal(guests.getGuest(invitation.guestId).sourceReady, false);
});
