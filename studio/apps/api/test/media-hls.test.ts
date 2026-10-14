import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { RealMediaGateway } from '../src/media.js';

const mediaSession = '8a87f601-6ed8-4b7a-8c0d-b3a08eabf3b5';

async function httpFixture(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

test('real media gateway follows the local MediaMTX session redirect without changing its resource', async (t) => {
  const requests: string[] = [];
  const base = await httpFixture(t, (request, response) => {
    if (request.url === '/v3/paths/list') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: [{ name: 'gabin/program', ready: true }] }));
      return;
    }
    requests.push(request.url!);
    if (request.url === '/gabin/program/index.m3u8') {
      response.writeHead(302, { location: `index.m3u8?session=${mediaSession}` });
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end(`#EXTM3U\nseg1.mp4?session=${mediaSession}\n`);
    }
  });
  const gateway = new RealMediaGateway({ apiUrl: base, hlsUrl: base, pollIntervalMs: 60_000 });
  t.after(() => gateway.close());
  const response = await gateway.hlsResource('index.m3u8');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /#EXTM3U/);
  assert.deepEqual(requests, ['/gabin/program/index.m3u8', `/gabin/program/index.m3u8?session=${mediaSession}`]);
  const segment = await gateway.hlsResource(`seg1.mp4?session=${mediaSession}`);
  await segment.text();
  assert.equal(requests.at(-1), `/gabin/program/seg1.mp4?session=${mediaSession}`);
});

test('MediaMTX cookie-check handshake stays internal before serving UUID session references', async (t) => {
  const requests: string[] = [];
  const base = await httpFixture(t, (request, response) => {
    if (request.url === '/v3/paths/list') { response.end('{"items":[]}'); return; }
    requests.push(request.url!);
    if (request.url === '/gabin/program/index.m3u8') {
      response.writeHead(302, { location: 'index.m3u8?cookieCheck=1' });
      response.end();
    } else if (request.url === '/gabin/program/index.m3u8?cookieCheck=1') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end(`#EXTM3U\n#EXT-X-MAP:URI="init.mp4?session=${mediaSession}"\nseg1.mp4?session=${mediaSession}\n`);
    } else {
      response.end('Real media segment fixture');
    }
  });
  const gateway = new RealMediaGateway({ apiUrl: base, hlsUrl: base, pollIntervalMs: 60_000 });
  t.after(() => gateway.close());
  const playlist = await gateway.hlsResource('index.m3u8');
  assert.equal(playlist.status, 200);
  assert.match(await playlist.text(), new RegExp(`seg1\\.mp4\\?session=${mediaSession}`));
  assert.deepEqual(requests, ['/gabin/program/index.m3u8', '/gabin/program/index.m3u8?cookieCheck=1']);
  const segment = await gateway.hlsResource(`seg1.mp4?session=${mediaSession}`);
  assert.equal(await segment.text(), 'Real media segment fixture');
  assert.equal(requests.at(-1), `/gabin/program/seg1.mp4?session=${mediaSession}`);
});

test('real media gateway rejects external redirects and local path, filename or query changes', async (t) => {
  let externalHits = 0;
  const outside = await httpFixture(t, (_request, response) => { externalHits++; response.end('Must not be fetched'); });
  const requests: string[] = [];
  let location = `${outside}/gabin/program/index.m3u8?session=${mediaSession}`;
  const base = await httpFixture(t, (request, response) => {
    if (request.url === '/v3/paths/list') { response.end('{"items":[]}'); return; }
    requests.push(request.url!);
    response.writeHead(302, { location });
    response.end();
  });
  const gateway = new RealMediaGateway({ apiUrl: base, hlsUrl: base, pollIntervalMs: 60_000 });
  t.after(() => gateway.close());
  const forbiddenRedirects = [
    location, `/other/program/index.m3u8?session=${mediaSession}`,
    `other.m3u8?session=${mediaSession}`, `../index.m3u8?session=${mediaSession}`,
    'index.m3u8?foo=value', 'index.m3u8?session=invalid',
    'index.m3u8?cookieCheck=2', 'index.m3u8?cookieCheck=1&unknown=value',
    'index.m3u8?cookieCheck=1&cookieCheck=1',
    `index.m3u8?session=${mediaSession}&session=${mediaSession}`,
    `index.m3u8?session=${mediaSession}#fragment`,
  ];
  for (const forbidden of forbiddenRedirects) {
    location = forbidden;
    const before = requests.length;
    await assert.rejects(gateway.hlsResource('index.m3u8'), forbidden);
    assert.equal(requests.length, before + 1, 'Only the original resource is fetched');
    assert.equal(externalHits, 0);
  }
  location = 'seg.ts?cookieCheck=1';
  const beforeSegmentRedirect = requests.length;
  await assert.rejects(gateway.hlsResource('seg.ts'));
  assert.equal(requests.length, beforeSegmentRedirect + 1);
  for (const resource of ['index.m3u8?foo=value', 'index.m3u8?session=invalid', `index.m3u8?session=${mediaSession}&session=${mediaSession}`, '../index.m3u8', 'index.m3u8?cookieCheck=1', 'seg.ts?cookieCheck=1']) {
    const before = requests.length;
    await assert.rejects(gateway.hlsResource(resource));
    assert.equal(requests.length, before);
  }
});
