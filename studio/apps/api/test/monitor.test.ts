import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import type { MediaState } from '@gabin/shared';
import { buildApp } from '../src/app.js';
import { emptyMediaState, type MediaGateway, type PrivateLiveDestination } from '../src/media.js';

class MediaFixture implements MediaGateway {
  state: MediaState = { ...emptyMediaState(), available: true, previewReady: true };
  requests: string[] = [];
  playlist = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg1.mp4\n';
  getState() { return structuredClone(this.state); }
  async refresh() { return this.getState(); }
  ingestSettings() { return { server: 'rtmp://127.0.0.1:1935/gabin', key: 'program' }; }
  async startLive(_destination: PrivateLiveDestination) {}
  async stopLive() {}
  subscribe(_listener: (state: MediaState) => void) { return () => undefined; }
  async close() {}
  async hlsResource(resource: string) {
    this.requests.push(resource);
    return resource.split('?')[0].endsWith('.m3u8') ? new Response(this.playlist, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
      : new Response('HLS MEDIA FIXTURE', { headers: { 'content-length': '17' } });
  }
}

test('monitor tickets permit native HLS without bearer, protect resources and honor device revocation', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gabin-monitor-'));
  const media = new MediaFixture();
  const app = await buildApp({ dataDir, media });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const tech = (await app.inject({ method: 'POST', url: '/api/auth/local' })).json();
  const techHeaders = { authorization: `Bearer ${tech.token}` };
  const pairing = (await app.inject({ method: 'POST', url: '/api/pairing', headers: techHeaders, payload: { role: 'viewer', kind: 'ipad' } })).json();
  const viewer = (await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: pairing.code, kind: 'ipad', name: 'iPad vue' } })).json();
  const viewerHeaders = { authorization: `Bearer ${viewer.token}` };
  assert.equal((await app.inject({ method: 'POST', url: '/api/monitor/session' })).statusCode, 401);
  const session = (await app.inject({ method: 'POST', url: '/api/monitor/session', headers: viewerHeaders })).json();
  assert.match(session.url, /^\/api\/monitor\/[A-Za-z0-9_-]{43}\/index.m3u8$/);
  const playlist = await app.inject({ method: 'GET', url: session.url });
  assert.equal(playlist.statusCode, 200, playlist.body);
  assert.equal(playlist.headers['cache-control'], 'no-store');
  assert.match(playlist.body, /URI="init.mp4"/);
  const segmentUrl = session.url.replace('index.m3u8', 'seg1.mp4');
  const segment = await app.inject({ method: 'GET', url: segmentUrl });
  assert.equal(segment.statusCode, 200);
  assert.equal(segment.body, 'HLS MEDIA FIXTURE');
  assert.equal((await app.inject({ method: 'GET', url: session.url.replace('index.m3u8', 'secret.sqlite') })).statusCode, 400);
  assert.equal(media.requests.includes('secret.sqlite'), false);
  media.playlist = '#EXTM3U\nhttps://external.example/leak.mp4\n';
  assert.equal((await app.inject({ method: 'GET', url: session.url })).statusCode, 502);
  assert.equal((await app.inject({ method: 'GET', url: session.url, headers: { origin: 'https://evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/devices/${viewer.device.id}`, headers: techHeaders })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: segmentUrl })).statusCode, 401);
});

test('monitor session creation cannot invent a program when media has not confirmed ready', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gabin-monitor-empty-'));
  const media = new MediaFixture();
  media.state.previewReady = false;
  const app = await buildApp({ dataDir, media });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const tech = (await app.inject({ method: 'POST', url: '/api/auth/local' })).json();
  const response = await app.inject({ method: 'POST', url: '/api/monitor/session', headers: { authorization: `Bearer ${tech.token}` } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'PREVIEW_NOT_READY');
  assert.equal(media.requests.length, 0);
});

test('MediaMTX session references remain protected and only its single UUID parameter is relayed', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gabin-monitor-session-'));
  const media = new MediaFixture();
  const upstreamSession = '8a87f601-6ed8-4b7a-8c0d-b3a08eabf3b5';
  const query = `?session=${upstreamSession}`;
  media.playlist = `#EXTM3U\n#EXT-X-MAP:URI="init.mp4${query}"\n#EXTINF:2.0,\nseg1.mp4${query}\n`;
  const app = await buildApp({ dataDir, media });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const tech = (await app.inject({ method: 'POST', url: '/api/auth/local' })).json();
  const headers = { authorization: `Bearer ${tech.token}` };
  const ticket = (await app.inject({ method: 'POST', url: '/api/monitor/session', headers })).json();
  const playlist = await app.inject({ method: 'GET', url: ticket.url });
  assert.equal(playlist.statusCode, 200, playlist.body);
  assert.match(playlist.body, new RegExp(`URI="init\\.mp4\\?session=${upstreamSession}"`));
  const protectedBase = ticket.url.replace('index.m3u8', '');
  for (const resource of [`init.mp4${query}`, `seg1.mp4${query}`, `index.m3u8${query}`]) {
    const response = await app.inject({ method: 'GET', url: protectedBase + resource });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(media.requests.at(-1), resource);
  }
  const invalidResources = [
    'seg1.mp4?foo=value', `seg1.mp4${query}&extra=value`,
    `seg1.mp4${query}&session=${upstreamSession}`, 'seg1.mp4?session=invalid',
    'index.m3u8?cookieCheck=1', 'seg1.mp4?cookieCheck=1',
    'seg1.mp4?session=', `seg1.mp4${query}#fragment`,
  ];
  for (const resource of invalidResources.filter(value => !value.includes('#'))) {
    const before = media.requests.length;
    const response = await app.inject({ method: 'GET', url: protectedBase + resource });
    assert.equal(response.statusCode, 400, `${resource}: ${response.body}`);
    assert.equal(media.requests.length, before);
  }
  const invalidReferences = [
    'https://external.example/leak.mp4', '//external.example/leak.mp4',
    '../secret.mp4', '%2e%2e/secret.mp4', 'directory/seg1.mp4',
    ...invalidResources,
  ];
  for (const resource of invalidReferences) {
    media.playlist = `#EXTM3U\n#EXTINF:2.0,\n${resource}\n`;
    assert.equal((await app.inject({ method: 'GET', url: ticket.url })).statusCode, 502, resource);
    media.playlist = `#EXTM3U\n#EXT-X-MAP:URI="${resource}"\n`;
    assert.equal((await app.inject({ method: 'GET', url: ticket.url })).statusCode, 502, resource);
  }
});
