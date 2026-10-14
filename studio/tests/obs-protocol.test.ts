import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { buildApp } from '../apps/api/src/app.js';
import { RealObsGateway } from '../apps/api/src/obs.js';
import { emptyMediaState, type MediaGateway, type PrivateLiveDestination } from '../apps/api/src/media.js';
import { startFakeObs } from './fake-obs.js';
import type { AudioFrame, AuthResult, MediaState, Project, StudioState, PairingCode, PreviewSession } from '@gabin/shared';

/** Control regression double; browser checks use the real MediaMTX/FFmpeg chain. */
class FakeMediaGateway implements MediaGateway {
  private state: MediaState = { ...emptyMediaState(), available: true };
  private listeners = new Set<(state: MediaState) => void>();
  getState(): MediaState { return structuredClone(this.state); }
  async refresh(): Promise<MediaState> { return this.getState(); }
  ingestSettings() { return { server: 'rtmp://127.0.0.1:1935/gabin', key: 'program' }; }
  setPreview(ready: boolean): void { this.update({ previewReady: ready }); }
  private update(changes: Partial<MediaState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener(this.getState());
  }
  async startLive(destination: PrivateLiveDestination): Promise<void> {
    this.update({ liveStatus: 'live', liveDestination: destination.name, liveBytes: 128_000 });
  }
  async stopLive(): Promise<void> { this.update({ liveStatus: 'idle', liveDestination: null, liveBytes: 0 }); }
  async hlsResource(_resource: string): Promise<Response> {
    return new Response('#EXTM3U\n#EXT-X-VERSION:3\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  subscribe(listener: (state: MediaState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> { this.listeners.clear(); }
}

test('real OBS protocol through the authenticated API, with iPad updates and saved takes', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gabin-wire-test-'));
  const media = new FakeMediaGateway();
  const obs = await startFakeObs({ recordDirectory: join(directory, 'recordings'),
    recordStartDelayMs: 600, streamStartDelayMs: 1700,
    onStreamStart: () => media.setPreview(true), onStreamStop: () => media.setPreview(false) });
  const app = await buildApp({ dataDir: join(directory, 'database'), media });
  const sockets: WebSocket[] = [];
  try {
    console.info('wire test: listen');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    console.info('wire test: local auth');
    const local = await app.inject({ method: 'POST', url: '/api/auth/local', payload: { name: 'Test PC' } });
    assert.equal(local.statusCode, 200);
    const technician = local.json<AuthResult>();
    const headers = { authorization: `Bearer ${technician.token}` };
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/state' });
    assert.equal(unauthenticated.statusCode, 401);
    const notLocal = await app.inject({ method: 'POST', url: '/api/auth/local', remoteAddress: '192.168.1.12', payload: { name: 'Remote' } });
    assert.equal(notLocal.statusCode, 403);

    const room = await app.inject({ method: 'PATCH', url: '/api/room', headers, payload: {
      obsUrl: obs.url, recordingRoot: join(directory, 'recordings'),
      defaultScenes: { podcast: 'Podcast', roundtable: 'Table ronde', slides: 'PowerPoint' },
      liveDestination: { name: 'Live de validation', server: 'rtmp://127.0.0.1:1936/live', key: 'fixture-private-live-key' },
    } });
    assert.equal(room.statusCode, 200);
    assert.equal('obsPassword' in room.json(), false);
    assert.equal(room.body.includes('fixture-private-live-key'), false);
    console.info('wire test: connect OBS');
    const connected = await app.inject({ method: 'POST', url: '/api/obs/connect', headers, payload: {} });
    assert.equal(connected.statusCode, 200, connected.body);
    assert.equal(connected.json<StudioState>().obs.connected, true);

    console.info('wire test: create project');
    const created = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: {
      title: 'Entretien de validation', owner: 'Technicien', format: 'roundtable',
      participants: [{ id: randomUUID(), name: 'Camille', micInput: 'Micro 1', sceneName: 'Caméra 1' }],
    } });
    assert.ok(created.statusCode >= 200 && created.statusCode < 300, created.body);
    const project = created.json<Project>();
    const preparation = await app.inject({ method: 'GET', url: `/api/preparation/${project.id}`, headers });
    assert.equal(preparation.statusCode, 200);
    assert.equal(preparation.json().canStart, true, preparation.body);

    console.info('wire test: pairing');
    const codeResponse = await app.inject({ method: 'POST', url: '/api/pairing', headers, payload: { role: 'operator', kind: 'ipad' } });
    assert.equal(codeResponse.statusCode, 200);
    const code = codeResponse.json<PairingCode>();
    const paired = await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: code.code, name: 'iPad test', kind: 'ipad' } });
    assert.equal(paired.statusCode, 200, paired.body);
    const tablet = paired.json<AuthResult>();
    const tabletHeaders = { authorization: `Bearer ${tablet.token}` };
    const repeatedCode = await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: code.code, name: 'Other iPad', kind: 'ipad' } });
    assert.ok(repeatedCode.statusCode >= 400);
    const roomByOperator = await app.inject({ method: 'PATCH', url: '/api/room', headers: tabletHeaders, payload: { name: 'Forbidden' } });
    assert.equal(roomByOperator.statusCode, 403);

    console.info('wire test: websocket');
    const tabletStates: StudioState[] = [];
    const tabletAudio: AudioFrame[] = [];
    const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/events', { origin: baseUrl });
    sockets.push(socket);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'state') tabletStates.push(message.state);
      else if (message.type === 'audio') tabletAudio.push(message.frame);
    });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'auth', token: tablet.token }));
    await waitUntil(() => tabletStates.length > 0);
    await waitUntil(() => tabletAudio.some(frame => frame.inputs.some(input => input.inputName === 'Micro 1' && input.peakDb > -50)));
    assert.ok(obs.identifications.some(subscriptions => (subscriptions & (1 << 16)) !== 0), 'Adapter subscribed to high-volume meters');
    assert.equal(JSON.stringify(tabletStates.at(-1)).includes('rmsDb'), false, 'Audio samples are ephemeral, not persistent studio state');

    console.info('wire test: control recording');
    const startCommand = { action: 'record.start', projectId: project.id, requestId: randomUUID() };
    const startingRecord = Promise.all([0, 1].map(() => app.inject({ method: 'POST', url: '/api/control', headers, payload: startCommand })));
    await waitUntil(() => obs.requests.some(request => request.requestType === 'StartRecord'));
    const pendingRecord = await app.inject({ method: 'GET', url: '/api/state', headers });
    assert.equal(pendingRecord.json<StudioState>().obs.recording, false, 'Early command ACK is not a recording confirmation');
    assert.equal(pendingRecord.json<StudioState>().activeTake, null, 'No take is presented as recording before OBS confirms it');
    const starts = await startingRecord;
    for (const response of starts) assert.equal(response.statusCode, 200, response.body);
    const active = starts[0]!.json<StudioState>().activeTake;
    assert.ok(active);
    assert.equal(obs.requests.filter(request => request.requestType === 'StartRecord').length, 1);
    await waitUntil(() => tabletStates.some(state => state.activeTake?.id === active.id && state.obs.recording));

    const pause = await app.inject({ method: 'POST', url: '/api/control', headers: tabletHeaders, payload: { action: 'record.pause' } });
    assert.equal(pause.statusCode, 200, pause.body);
    assert.equal(pause.json<StudioState>().obs.paused, true);
    const resume = await app.inject({ method: 'POST', url: '/api/control', headers, payload: { action: 'record.resume' } });
    assert.equal(resume.statusCode, 200, resume.body);
    const scene = await app.inject({ method: 'POST', url: '/api/control', headers: tabletHeaders, payload: { action: 'scene.set', sceneName: 'Caméra 1' } });
    assert.equal(scene.statusCode, 200, scene.body);
    assert.equal(scene.json<StudioState>().obs.currentScene, 'Caméra 1');
    const mute = await app.inject({ method: 'POST', url: '/api/control', headers, payload: { action: 'input.mute', inputName: 'Micro 1', muted: true } });
    assert.equal(mute.statusCode, 200, mute.body);
    assert.equal(mute.json<StudioState>().obs.inputs.find(input => input.name === 'Micro 1')?.muted, true);
    await waitUntil(() => tabletAudio.some(frame => frame.inputs.some(input => input.inputName === 'Micro 1' && input.peakDb <= -80)));
    const unmute = await app.inject({ method: 'POST', url: '/api/control', headers, payload: { action: 'input.mute', inputName: 'Micro 1', muted: false } });
    assert.equal(unmute.statusCode, 200, unmute.body);
    const marker = await app.inject({ method: 'POST', url: '/api/control', headers: tabletHeaders, payload: { action: 'marker.add', label: 'À garder' } });
    assert.equal(marker.statusCode, 200, marker.body);
    assert.equal(marker.json<StudioState>().markers.filter(item => item.takeId === active.id).length, 1);

    console.info('wire test: preview and public live are separate from recording');
    const startingPreview = app.inject({ method: 'POST', url: '/api/control', headers: tabletHeaders, payload: { action: 'preview.start' } });
    await waitUntil(() => obs.requests.some(request => request.requestType === 'StartStream'));
    const pendingPreview = await app.inject({ method: 'GET', url: '/api/state', headers });
    assert.equal(pendingPreview.json<StudioState>().obs.streaming, false, 'Local output is still starting after StartStream ACK');
    const preview = await startingPreview;
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json<StudioState>().obs.streaming, true);
    assert.equal(obs.requests.filter(request => request.requestType === 'StartStream').length, 1, 'Delayed output confirmation never replays StartStream');
    assert.equal(preview.json<StudioState>().media.previewReady, true);
    const live = await app.inject({ method: 'POST', url: '/api/control', headers, payload: { action: 'stream.start', projectId: project.id } });
    assert.equal(live.statusCode, 200, live.body);
    assert.equal(live.json<StudioState>().media.liveStatus, 'live');
    assert.equal(live.json<StudioState>().liveProjectId, project.id);
    assert.equal(live.body.includes('fixture-private-live-key'), false);
    const previewDuringLive = await app.inject({ method: 'POST', url: '/api/control', headers, payload: { action: 'preview.stop' } });
    assert.equal(previewDuringLive.statusCode, 409, previewDuringLive.body);
    const sessionResponse = await app.inject({ method: 'POST', url: '/api/monitor/session', headers: tabletHeaders });
    assert.equal(sessionResponse.statusCode, 200, sessionResponse.body);
    const session = sessionResponse.json<PreviewSession>();
    const playlist = await app.inject({ method: 'GET', url: session.url });
    assert.equal(playlist.statusCode, 200, playlist.body);
    assert.match(playlist.body, /^#EXTM3U/);
    socket.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    const afterTabletClose = await app.inject({ method: 'GET', url: '/api/state', headers });
    assert.equal(afterTabletClose.json<StudioState>().media.liveStatus, 'live', 'Closing a controller preserves public live');
    assert.equal(afterTabletClose.json<StudioState>().obs.recording, true, 'Closing a controller preserves local recording');
    const stoppedLive = await app.inject({ method: 'POST', url: '/api/control', headers: tabletHeaders, payload: { action: 'stream.stop' } });
    assert.equal(stoppedLive.statusCode, 200, stoppedLive.body);
    assert.equal(stoppedLive.json<StudioState>().media.liveStatus, 'idle');
    assert.equal(stoppedLive.json<StudioState>().obs.recording, true, 'Stopping public live preserves local recording');
    assert.equal(stoppedLive.json<StudioState>().obs.streaming, true, 'Stopping public live preserves local preview feed');
    assert.equal(obs.requests.filter(request => request.requestType === 'StopRecord').length, 0);
    const stoppedPreview = await app.inject({ method: 'POST', url: '/api/control', headers, payload: { action: 'preview.stop' } });
    assert.equal(stoppedPreview.statusCode, 200, stoppedPreview.body);
    assert.equal(stoppedPreview.json<StudioState>().obs.recording, true, 'Stopping preview preserves recording');

    // Closing the remote control must not send StopRecord to OBS.
    socket.close();
    assert.equal(obs.requests.filter(request => request.requestType === 'StopRecord').length, 0);
    console.info('wire test: stop recording');
    const stopped = await app.inject({ method: 'POST', url: '/api/control', headers, payload: { action: 'record.stop', requestId: randomUUID() } });
    assert.equal(stopped.statusCode, 200, stopped.body);
    const finished = stopped.json<StudioState>().takes.find(take => take.id === active.id);
    assert.equal(finished?.status, 'completed');
    assert.ok(finished?.outputPath);
    const download = await app.inject({ method: 'GET', url: `/api/takes/${active.id}/file`, headers });
    assert.equal(download.statusCode, 200, download.body);
    assert.match(download.body, /TEST FIXTURE/);
    const ticketResponse = await app.inject({ method: 'POST', url: `/api/takes/${active.id}/download-ticket`, headers: tabletHeaders });
    assert.equal(ticketResponse.statusCode, 200, ticketResponse.body);
    const ticket = ticketResponse.json<{url: string}>();
    const partial = await app.inject({ method: 'GET', url: ticket.url, headers: { range: 'bytes=0-3' } });
    assert.equal(partial.statusCode, 206, partial.body);
    assert.equal(partial.body, 'TEST');
    const head = await app.inject({ method: 'HEAD', url: ticket.url });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');

    const revoke = await app.inject({ method: 'DELETE', url: `/api/devices/${tablet.device.id}`, headers });
    assert.ok(revoke.statusCode >= 200 && revoke.statusCode < 300);
    const revoked = await app.inject({ method: 'GET', url: '/api/state', headers: tabletHeaders });
    assert.equal(revoked.statusCode, 401);
    const revokedDownload = await app.inject({ method: 'GET', url: ticket.url });
    assert.equal(revokedDownload.statusCode, 401);
    const revokedPreview = await app.inject({ method: 'GET', url: session.url });
    assert.equal(revokedPreview.statusCode, 401);
    console.info('wire test: restart app');
    await app.close();

    const restarted = await buildApp({ dataDir: join(directory, 'database'), media: new FakeMediaGateway() });
    try {
      const persisted = await restarted.inject({ method: 'GET', url: '/api/state', headers });
      assert.equal(persisted.statusCode, 200);
      assert.equal(persisted.json<StudioState>().projects.find(item => item.id === project.id)?.title, project.title);
      assert.equal(persisted.json<StudioState>().takes.find(item => item.id === active.id)?.outputPath, finished?.outputPath);
    } finally { await restarted.close(); }
  } finally {
    console.info('wire test: teardown');
    for (const socket of sockets) socket.terminate();
    await app.close().catch(() => undefined);
    await obs.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('State update did not arrive before the timeout');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('a silent OBS socket cannot hold the controller indefinitely', { timeout: 15_000 }, async () => {
  const silent = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => { silent.once('listening', resolve); silent.once('error', reject); });
  const address = silent.address();
  assert.ok(address && typeof address !== 'string');
  const gateway = new RealObsGateway();
  try {
    await assert.rejects(gateway.connect(`ws://127.0.0.1:${address.port}`, ''));
    assert.equal(gateway.getState().connected, false);
    assert.equal(gateway.getState().connecting, false);
    assert.ok(gateway.getState().error);
  } finally {
    for (const socket of silent.clients) socket.terminate();
    await gateway.disconnect();
    await new Promise<void>((resolve, reject) => silent.close(error => error ? reject(error) : resolve()));
  }
});
