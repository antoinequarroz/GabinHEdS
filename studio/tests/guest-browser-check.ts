import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app.js';
import { buildGuestApp } from '../apps/api/src/guest-app.js';
import { emptyMediaState, type MediaGateway } from '../apps/api/src/media.js';
import { startFakeObs } from './fake-obs.js';
import { startStunFixture } from './stun-fixture.js';
import { noOverflow, proofScreenshot } from './browser-rendering.js';
import type { AuthResult, GuestSlot, MediaState, PairingCode, Project, StudioState } from '@gabin/shared';

// Capture devices and OBS are fixtures. RTCPeerConnection, its encoded packets,
// remote video decoding, the signalling API and audio mixing are real.
class QuietMedia implements MediaGateway {
  getState(): MediaState { return emptyMediaState(); }
  async refresh(): Promise<MediaState> { return this.getState(); }
  ingestSettings() { return { server: 'rtmp://127.0.0.1:1/fixture', key: 'unused' }; }
  async startLive(): Promise<void> { throw new Error('This WebRTC test must never start a live encoder.'); }
  async stopLive(): Promise<void> {}
  async hlsResource(): Promise<Response> { return new Response('', { status: 404 }); }
  subscribe(): () => void { return () => {}; }
  async close(): Promise<void> {}
}

const require = createRequire(import.meta.url);
const fallback = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
let playwright: any;
if (process.env.GABIN_PLAYWRIGHT_MODULE) playwright = require(process.env.GABIN_PLAYWRIGHT_MODULE);
else { try { playwright = require('playwright'); } catch (failure) { if (!existsSync(fallback)) throw failure; playwright = require(fallback); } }
const engine = process.env.GABIN_TEST_BROWSER || 'chromium';
if (!['chromium', 'webkit'].includes(engine)) throw new Error('GABIN_TEST_BROWSER doit être chromium ou webkit.');
const tabletEngine = process.env.GABIN_GUEST_TABLET_BROWSER || engine;
if (!['chromium', 'webkit'].includes(tabletEngine)) throw new Error('GABIN_GUEST_TABLET_BROWSER doit être chromium ou webkit.');
// OBS BrowserSource runs Chromium/CEF with this autoplay policy, including on
// macOS. WebKit still exercises the actual bridge, callers and iPad controls.
const sourceEngine = 'chromium';
const screenshotDir = process.env.GABIN_GUEST_SCREENSHOT_DIR || join(tmpdir(), `nino-guests-${engine}`);
const temp = await mkdtemp(join(tmpdir(), 'nino-guests-e2e-'));
const failures: string[] = []; const steps: string[] = [];
let fixture: Awaited<ReturnType<typeof startFakeObs>> | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let publicApp: Awaited<ReturnType<typeof buildGuestApp>> | undefined;
let stun: Awaited<ReturnType<typeof startStunFixture>> | undefined;
let browser: any; let tabletBrowser: any; let sourceBrowser: any; let base = ''; let token = '';
const pages: any[] = [];

async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}
async function request<T>(path: string, body?: unknown, bearer = token, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`${base}/api${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function stateWhen(predicate: (state: StudioState) => boolean, description: string, timeout = 35_000): Promise<StudioState> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const state = await request<StudioState>('/state'); if (predicate(state)) { steps.push(description); console.info(description); return state; } await new Promise(resolve => setTimeout(resolve, 200)); }
  const state = await request<StudioState>('/state');
  throw new Error(`${description} n’est pas confirmé. ${JSON.stringify(state.guestRooms)}`);
}
function observe(page: any): any {
  pages.push(page); page.on('pageerror', (error: Error) => failures.push(error.message));
  page.on('console', (message: any) => { if (message.type() === 'error' && !message.text().includes('404')) failures.push(message.text().replace(/[a-zA-Z0-9_-]{43}/g, '<token>')); });
  return page;
}

async function captureFixture(context: any, frequency: number, label: string, privateToken?: string): Promise<void> {
  const setup = ({ frequency, label, privateToken, base }: { frequency: number; label: string; privateToken?: string; base: string }) => {
    if (privateToken && location.origin === base) localStorage.setItem('gabin.studio.device', privateToken);
    (window as any).__fixtureCaptureCount = 0;
    (window as any).__fixtureSocketEvents = [];
    (window as any).__fixtureMediaEvents = [];
    const recordMedia = (value: Record<string, unknown>) => {
      const events = (window as any).__fixtureMediaEvents as unknown[];
      events.push({ at: new Date().toISOString(), ...value });
      if (events.length > 256) events.shift();
    };
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function observedPlay() {
      return Reflect.apply(nativePlay, this, []).catch((failure: Error) => {
        recordMedia({ type: 'play-error', name: failure.name, message: failure.message.replace(/[a-zA-Z0-9_-]{43}/g, '<token>'), className: this.className, muted: this.muted, paused: this.paused, readyState: this.readyState, streamId: this.srcObject instanceof MediaStream ? this.srcObject.id : null });
        throw failure;
      });
    };
    const NativeWebSocket = WebSocket;
    // Observe the original socket's events without changing signalling,
    // authentication, ping/pong, close codes or transport behaviour.
    (window as any).WebSocket = new Proxy(NativeWebSocket, { construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget) as WebSocket;
      const route = new URL(String(args[0]), location.href).pathname; let role = ''; let previousRoom = '';
      const record = (value: Record<string, unknown>) => {
        const events = (window as any).__fixtureSocketEvents as unknown[];
        events.push({ at: new Date().toISOString(), route, role, ...value });
        if (events.length > 32) events.shift();
      };
      socket.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'welcome') role = String(data.peer?.role ?? '');
          if (data.type === 'error') record({ type: 'error', message: String(data.error ?? '').replace(/[a-zA-Z0-9_-]{43}/g, '<token>') });
          if ((data.type === 'welcome' || data.type === 'room') && data.room) {
            const summary = { bridge: { connected: data.room.bridge.connected, mediaReady: data.room.bridge.mediaReady }, guests: data.room.guests.map((guest: GuestSlot) => ({ id: guest.id, status: guest.status, admitted: guest.admitted, muted: guest.muted, joined: guest.joined, mediaReady: guest.mediaReady, sourceReady: guest.sourceReady })) };
            const key = JSON.stringify(summary);
            if (key !== previousRoom) { previousRoom = key; recordMedia({ type: 'room', role, ...summary }); }
          }
        } catch { /* Binary or other protocol messages are not diagnostics. */ }
      });
      const nativeSend = socket.send;
      socket.send = function observedSend(data) {
        const result = Reflect.apply(nativeSend, this, [data]);
        if (typeof data === 'string') {
          try { const message = JSON.parse(data); if (message.type === 'media') recordMedia({ type: 'media-report', role, guestId: message.guestId, ready: message.ready, audio: message.audio, video: message.video }); }
          catch { /* Only the readiness booleans, never auth/SDP, are recorded. */ }
        }
        return result;
      };
      socket.addEventListener('close', event => record({ type: 'close', code: event.code, reason: event.reason.replace(/[a-zA-Z0-9_-]{43}/g, '<token>') }));
      return socket;
    } });
    // Observe real native peers for failure diagnostics; signalling, transport,
    // tracks and every return value remain the browser's own implementation.
    (window as any).__fixturePeers = [];
    const prototype = RTCPeerConnection.prototype as any;
    for (const method of ['createOffer', 'setRemoteDescription']) {
      const native = prototype[method];
      prototype[method] = function (...args: unknown[]) {
        if (!(window as any).__fixturePeers.includes(this)) (window as any).__fixturePeers.push(this);
        return Reflect.apply(native, this, args);
      };
    }
    const nativeStats = prototype.getStats;
    prototype.getStats = function observedStats(...args: unknown[]) {
      const startedAt = Date.now(); const peer = this;
      return Reflect.apply(nativeStats, peer, args).then((stats: RTCStatsReport) => {
        const rtp: unknown[] = [];
        stats.forEach(stat => { if (stat.type === 'inbound-rtp' || stat.type === 'outbound-rtp') rtp.push({ type: stat.type, kind: stat.kind ?? stat.mediaType, timestamp: stat.timestamp, bytesReceived: stat.bytesReceived, bytesSent: stat.bytesSent, framesDecoded: stat.framesDecoded, framesEncoded: stat.framesEncoded }); });
        recordMedia({ type: 'rtc-stats', startedAt, endedAt: Date.now(), peer: (window as any).__fixturePeers.indexOf(peer), state: peer.connectionState, rtp });
        return stats;
      });
    };
    const mediaDevices = navigator.mediaDevices || {};
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    Object.defineProperty(mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [
      { kind: 'videoinput', deviceId: 'fixture-video', groupId: 'fixture-group', label: frequency === 440 ? 'OBS Virtual Camera · mire de test' : `Caméra de test ${label}`, toJSON() { return this; } },
      { kind: 'audioinput', deviceId: 'fixture-audio', groupId: 'fixture-group', label: `Micro de test ${label}`, toJSON() { return this; } },
    ] });
    Object.defineProperty(mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      (window as any).__fixtureCaptureCount++;
      if (frequency === 0) throw new Error('Cet appareil de contrôle ne doit pas ouvrir de caméra ni de micro.');
      (window as any).__fixtureCaptureStage = 'canvas';
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const paint = canvas.getContext('2d')!; let frame = 0;
      const draw = () => { frame++; paint.fillStyle = `hsl(${(frame * 7 + frequency) % 360} 45% 30%)`; paint.fillRect(0, 0, 640, 360);
        for (let index = 0; index < 8; index++) { paint.fillStyle = `hsl(${(index * 47 + frame) % 360} 70% 58%)`; paint.fillRect(index * 80, 270, 80, 90); }
        paint.fillStyle = '#f2f3f8'; paint.font = 'bold 38px sans-serif'; paint.fillText('NINO · TEST WEBRTC', 28, 60); paint.font = '25px sans-serif'; paint.fillText(label, 28, 104); paint.fillText(`IMAGE ${frame}`, 28, 152);
      }; draw(); const timer = setInterval(draw, 50);
      (window as any).__fixtureCaptureStage = 'canvas.captureStream'; const video = canvas.captureStream(20);
      (window as any).__fixtureCaptureStage = 'AudioContext'; const audio = new AudioContext();
      (window as any).__fixtureCaptureStage = 'AudioContext.resume'; await audio.resume(); const oscillator = audio.createOscillator(); oscillator.frequency.value = frequency;
      (window as any).__fixtureCaptureStage = 'createMediaStreamDestination'; const gain = audio.createGain(); gain.gain.value = .18; const destination = audio.createMediaStreamDestination();
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      const stream = new MediaStream([...video.getVideoTracks(), ...destination.stream.getAudioTracks()]);
      for (const track of stream.getTracks()) {
        (window as any).__fixtureCaptureStage = 'track.getSettings';
        const settings = track.getSettings.bind(track);
        Object.defineProperty(track, 'getSettings', { value: () => ({ ...settings(), deviceId: track.kind === 'video' ? 'fixture-video' : 'fixture-audio' }) });
      }
      (window as any).__fixtureResources = ((window as any).__fixtureResources || []).concat([{ canvas, stream, timer, audio, oscillator }]);
      (window as any).__fixtureCaptureStage = 'ready';
      return stream;
    } });
  };
  // tsx preserves nested function names with a __name helper. Supply that tiny
  // helper in the init-script world; it does not replace any browser media API.
  await context.addInitScript({ content: `(() => { const __name = value => value; (${setup.toString()})(${JSON.stringify({ frequency, label, privateToken, base })}); })();` });
}

async function liveFrames(page: any, selector: string, label: string): Promise<void> {
  await page.bringToFront();
  await page.waitForFunction((selector: string) => {
    const video = document.querySelector(selector) as HTMLVideoElement | null;
    return video && video.srcObject instanceof MediaStream && video.readyState >= 2 && !video.paused
      && video.videoWidth === 640 && video.videoHeight === 360 && video.getVideoPlaybackQuality().totalVideoFrames > 8;
  }, selector, { timeout: 30_000 });
  const fingerprint = () => page.locator(selector).evaluate((video: HTMLVideoElement) => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36; const paint = canvas.getContext('2d')!;
    paint.drawImage(video, 0, 0, 64, 36); return [...paint.getImageData(0, 0, 64, 36).data].reduce((hash, value, index) => ((hash * 31) ^ (value + index)) >>> 0, 0);
  });
  const first = await fingerprint(); await page.waitForTimeout(450); const second = await fingerprint();
  assert.notEqual(first, second, `${label} doit présenter de nouvelles images décodées`);
  steps.push(`${label} : images WebRTC 640 × 360 décodées et renouvelées`);
}

async function spectrum(page: any, selector: string): Promise<Record<number, number>> {
  await page.bringToFront();
  return page.locator(selector).evaluate(async (video: HTMLVideoElement) => {
    const stream = video.srcObject; if (!(stream instanceof MediaStream) || !stream.getAudioTracks().length) throw new Error('Aucune piste audio WebRTC reçue.');
    let probe = (window as any).__audioProbe;
    if (!probe || probe.stream !== stream) {
      if (probe) { probe.source.disconnect(); await probe.context.close(); }
      const context = new AudioContext(); const source = context.createMediaStreamSource(stream); const analyser = context.createAnalyser(); analyser.fftSize = 8192; analyser.smoothingTimeConstant = 0;
      const silent = context.createGain(); silent.gain.value = 0; source.connect(analyser); analyser.connect(silent); silent.connect(context.destination);
      probe = { stream, context, source, analyser }; (window as any).__audioProbe = probe;
    }
    await probe.context.resume(); if (probe.context.state !== 'running') throw new Error('Analyse audio suspendue par le navigateur.');
    await new Promise(resolve => setTimeout(resolve, 240));
    const bins = new Float32Array(probe.analyser.frequencyBinCount); probe.analyser.getFloatFrequencyData(bins);
    return Object.fromEntries([440, 660, 880].map(frequency => {
      const center = Math.round(frequency * probe.analyser.fftSize / probe.context.sampleRate);
      return [frequency, Math.max(...bins.subarray(Math.max(0, center - 3), center + 4))];
    }));
  });
}
async function toneProof(page: any, selector: string, present: number[], absent: number[], label: string): Promise<void> {
  const deadline = Date.now() + 12_000; let result: Record<number, number> = {};
  while (Date.now() < deadline) {
    result = await spectrum(page, selector);
    if (present.every(tone => result[tone] > -45) && absent.every(tone => result[tone] < -60)) {
      const measured = JSON.stringify(result, (_key, value) => value === -Infinity ? '-inf (silence)' : value);
      steps.push(`${label} : ${measured}`); console.info(label, measured); return;
    }
    await page.waitForTimeout(350);
  }
  throw new Error(`${label} : spectre inattendu ${JSON.stringify(result)} ; présents=${present}, exclus=${absent}`);
}
async function screenshot(page: any, name: string, panelOnly = false): Promise<void> {
  const webkit = page.context().browser().browserType().name() === 'webkit';
  await page.bringToFront(); await page.evaluate(() => document.fonts.ready); await noOverflow(page, name);
  await page.addStyleTag({ content: '.guest-invitation input { color: transparent !important; text-shadow: none !important; }' });
  if (panelOnly) {
    // The desktop inspector is scrollable. Enlarge only the test viewport for
    // a complete component portrait; preserve its real PC/iPad width and CSS.
    const viewport = page.viewportSize();
    try { await page.setViewportSize({ width: viewport.width, height: 3600 }); await page.locator('.guest-panel').scrollIntoViewIfNeeded();
      await page.locator('.guest-panel').screenshot({ path: join(screenshotDir, name) }); }
    finally { await page.setViewportSize(viewport); }
  }
  else await proofScreenshot(page, join(screenshotDir, name), webkit);
}

try {
  await mkdir(screenshotDir, { recursive: true }); const guestPort = await freePort();
  if (process.env.GABIN_GUEST_TEST_STUN === '1') stun = await startStunFixture();
  fixture = await startFakeObs({ meters: false, specialInputs: { mic1: 'Micro 1' } });
  app = await buildApp({ dataDir: join(temp, 'database'), media: new QuietMedia(), webDir: join(process.cwd(), 'apps/web/dist'), guestConfig: { port: guestPort, publicUrl: `http://127.0.0.1:${guestPort}`, ...(stun ? { stunUrls: [stun.url] } : {}) } });
  await app.listen({ host: '127.0.0.1', port: 0 }); const address = app.server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
  publicApp = await buildGuestApp({ guests: app.guests, webDir: join(process.cwd(), 'apps/web/dist') }); await publicApp.listen({ host: '127.0.0.1', port: guestPort });
  const auth = await request<AuthResult>('/auth/local', { name: 'PC de validation WebRTC' }); token = auth.token;
  await request('/room', { obsUrl: fixture.url, recordingRoot: join(temp, 'recordings'), defaultScenes: { podcast: 'Podcast', roundtable: 'Table ronde', slides: 'PowerPoint' } }, token, 'PATCH');
  await request('/obs/connect', {});
  const project = await request<Project>('/projects', { title: 'Conversation Nino · test des invités', owner: 'Équipe de test', format: 'roundtable', participants: [
    { id: randomUUID(), name: 'Camille · salle', micInput: 'Micro 1', sceneName: 'Caméra 1' }, { id: randomUUID(), name: 'Alex · salle', micInput: 'Micro 2', sceneName: 'Caméra 2' },
  ] });
  const pairing = await request<PairingCode>('/pairing', { role: 'operator', kind: 'ipad' });
  const paired = await request<AuthResult>('/auth/pair', { code: pairing.code, name: 'iPad de validation', kind: 'ipad' });
  const deck = await request<AuthResult>('/devices', { role: 'operator', kind: 'streamdeck', name: 'Stream Deck de validation' });
  const chromiumOptions = { headless: true, ...(process.env.GABIN_CHROMIUM_CHANNEL ? { channel: process.env.GABIN_CHROMIUM_CHANNEL } : {}), args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] };
  browser = await playwright[engine].launch(engine === 'chromium' ? chromiumOptions : { headless: true });
  const pcContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await captureFixture(pcContext, 440, 'SALLE · 440 Hz', token);
  if (tabletEngine !== engine) tabletBrowser = await playwright[tabletEngine].launch({ headless: true });
  const ipadContext = await (tabletBrowser || browser).newContext({ viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true }); await captureFixture(ipadContext, 0, 'IPAD CONTRÔLE', paired.token);
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 1280, height: 850 } }), browser.newContext({ viewport: { width: 1280, height: 850 } })]);
  await captureFixture(contexts[0], 660, 'CAMILLE À DISTANCE · 660 Hz'); await captureFixture(contexts[1], 880, 'LOUIS À DISTANCE · 880 Hz');
  if (engine !== sourceEngine) sourceBrowser = await playwright.chromium.launch(chromiumOptions);
  const sourceContext = await (sourceBrowser || browser).newContext({ viewport: { width: 640, height: 360 } }); await captureFixture(sourceContext, 0, 'OBS SOURCE');
  if (engine === 'webkit') {
    // WebKit withholds host ICE candidates from untrusted capture origins even
    // when our synthetic MediaStreams are valid. These grants affect only the
    // disposable browser contexts; native hardware remains replaced by fixtures.
    await pcContext.grantPermissions(['camera', 'microphone'], { origin: base });
    for (const context of contexts) await context.grantPermissions(['camera', 'microphone'], { origin: `http://127.0.0.1:${guestPort}` });
  }
  const pc = observe(await pcContext.newPage()); const ipad = observe(await ipadContext.newPage());
  await pc.goto(`${base}/#project/${project.id}`); await pc.getByRole('button', { name: 'Enregistrer et diffuser', exact: true }).click();
  await ipad.goto(`${base}/#project/${project.id}`); await ipad.getByRole('button', { name: 'Enregistrer et diffuser', exact: true }).click();
  const panel = pc.locator('.guest-panel'); await panel.waitFor();
  await panel.locator('#invite-name-1').fill('Camille à distance'); await panel.locator('.guest-slot').nth(0).getByRole('button', { name: 'Créer un lien d’invitation', exact: true }).click();
  await panel.locator('#invite-name-2').fill('Louis à distance'); await panel.locator('.guest-slot').nth(1).getByRole('button', { name: 'Créer un lien d’invitation', exact: true }).click();
  await panel.locator('#invite-link-1').waitFor(); await panel.locator('#invite-link-2').waitFor();
  const urls = await Promise.all([panel.locator('#invite-link-1').inputValue(), panel.locator('#invite-link-2').inputValue()]);
  const bridgePromise = pc.waitForEvent('popup'); await panel.getByRole('button', { name: 'Ouvrir la liaison de la salle', exact: true }).click(); const bridge = observe(await bridgePromise);
  await bridge.waitForURL(`${base}/guest-bridge#guest-bridge`); await bridge.getByRole('button', { name: 'Ouvrir caméra et micro', exact: true }).waitFor();
  assert.equal(await bridge.evaluate(() => navigator.mediaDevices.getUserMedia.toString().includes('__fixtureCaptureCount')), true, 'fixture capture must replace physical devices before the UI opens them');
  await bridge.getByRole('button', { name: 'Ouvrir caméra et micro', exact: true }).click(); await liveFrames(bridge, '.guest-programme video', 'Aperçu programme du pont');
  await bridge.getByRole('checkbox', { name: 'L’image sélectionnée est le programme de la caméra virtuelle OBS.', exact: true }).check();
  await bridge.getByRole('checkbox', { name: 'Cette entrée contient toutes les voix de la salle, sans le retour sonore des invités.', exact: true }).check();
  await bridge.getByRole('button', { name: 'Connecter la salle aux invités', exact: true }).click();
  await stateWhen(state => !!state.guestRooms?.[project.id]?.bridge.mediaReady, 'Le pont salle confirme de vraies images et une piste audio');
  const guestPages = await Promise.all(contexts.map(async (context: any, index: number) => {
    const page = observe(await context.newPage()); await page.goto(urls[index]); await page.getByRole('button', { name: 'Vérifier caméra et micro', exact: true }).click(); await liveFrames(page, '.guest-programme video', `Aperçu invité ${index + 1}`);
    if (index === 0) await screenshot(page, 'nino-invite-avant-appel.png');
    await page.getByRole('button', { name: 'Rejoindre la salle', exact: true }).click(); return page;
  }));
  const ready = await stateWhen(state => state.guestRooms?.[project.id]?.guests.length === 2 && state.guestRooms[project.id].guests.every(guest => guest.joined && guest.mediaReady), 'Les deux invités transmettent leurs médias à la salle');
  const guests = ready.guestRooms![project.id].guests;
  await panel.getByRole('button', { name: 'Préparer les sources OBS', exact: true }).click();
  await stateWhen(state => guests.every(guest => state.obs.inputs.some(input => input.name === guest.inputName && input.muted === true)), 'OBS confirme les deux sources initialement muettes');
  const sourcePages = await Promise.all(guests.map(async guest => {
    const created = fixture!.requests.find(request => request.requestType === 'CreateInput' && request.requestData.inputName === guest.inputName);
    assert.ok(created); const settings = created.requestData.inputSettings as { url: string }; const page = observe(await sourceContext.newPage()); await page.goto(settings.url);
    await page.locator('.guest-source video').waitFor(); return page;
  }));
  const deniedScene = await fetch(`${base}/api/control`, { method: 'POST', headers: { Authorization: `Bearer ${deck.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'guest.scene', guestId: guests[0].id }) });
  assert.equal(deniedScene.status, 409, 'unadmitted remote cannot become programme');
  await panel.locator('.guest-slot').nth(0).getByRole('button', { name: 'Accueillir dans la conversation', exact: true }).click();
  await ipad.locator('.guest-slot').nth(1).getByRole('button', { name: 'Accueillir dans la conversation', exact: true }).click();
  await stateWhen(state => state.guestRooms![project.id].guests.every(guest => guest.admitted && guest.sourceReady && !guest.muted), 'Admission PC/iPad et réception OBS réellement confirmées');
  for (let index = 0; index < 2; index++) { await liveFrames(guestPages[index], '.guest-programme video', `Retour programme invité ${index + 1}`); await liveFrames(sourcePages[index], '.guest-source video', `Source OBS invité ${index + 1}`); }
  await pc.bringToFront(); await pc.waitForTimeout(12_000);
  await stateWhen(state => state.guestRooms![project.id].bridge.mediaReady && state.guestRooms![project.id].guests.every(guest => guest.admitted && guest.sourceReady), 'La liaison reste prête pendant 12 secondes derrière la régie');
  await liveFrames(guestPages[0], '.guest-programme video', 'Retour invité après arrière-plan du pont');
  const desktopGuestViewport = guestPages[0].viewportSize();
  await guestPages[0].setViewportSize({ width: 390, height: 844 }); await noOverflow(guestPages[0], 'invité mobile 390 px');
  await liveFrames(guestPages[0], '.guest-programme video', 'Retour vidéo sur écran mobile 390 px');
  await screenshot(guestPages[0], 'nino-invite-mobile-390.png'); await guestPages[0].setViewportSize(desktopGuestViewport);
  await toneProof(guestPages[0], '.guest-programme video', [440, 880], [660], 'Retour invité 1 : salle + invité 2, aucune voix propre');
  await toneProof(guestPages[1], '.guest-programme video', [440, 660], [880], 'Retour invité 2 : salle + invité 1, aucune voix propre');
  await toneProof(sourcePages[0], '.guest-source video', [660], [440, 880], 'Source OBS 1 : uniquement la voix invité 1');
  await toneProof(sourcePages[1], '.guest-source video', [880], [440, 660], 'Source OBS 2 : uniquement la voix invité 2');
  // Force two real readiness polls to complete in reverse order. A late native
  // snapshot must never turn a still-decoding OBS source into a false failure.
  const holdSourceSnapshot = () => {
    const video = document.querySelector('.guest-source video') as HTMLVideoElement;
    const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    const peer = ((window as any).__fixturePeers as RTCPeerConnection[]).find(candidate => candidate.getReceivers().some(receiver => receiver.track === track));
    if (!track || !peer) throw new Error('The active OBS source must receive a real native video track.');
    const original = peer.getStats; const nativeStats = original.bind(peer);
    const gate: any = { waiting: false, resumed: false, older: null, newer: null, release: () => {}, restore: () => { peer.getStats = original; } };
    (window as any).__fixtureSourceStatsGate = gate;
    peer.getStats = async function delayedSourceSnapshot() {
      const stats = await nativeStats(); let sample: { timestamp: number; framesDecoded: number } | undefined;
      stats.forEach(stat => { if (stat.type === 'inbound-rtp' && (stat.kind ?? stat.mediaType) === 'video') sample = { timestamp: stat.timestamp, framesDecoded: stat.framesDecoded }; });
      if (!sample || !Number.isFinite(sample.timestamp) || !Number.isFinite(sample.framesDecoded)) throw new Error('The native inbound video report must expose its real timestamp and decoded frames.');
      if (!gate.waiting) {
        gate.waiting = true; gate.older = sample;
        await new Promise<void>(resolve => { gate.release = resolve; });
        gate.resumed = true;
      } else if (!gate.newer && sample.timestamp > gate.older.timestamp && sample.framesDecoded > gate.older.framesDecoded) {
        gate.newer = { ...sample, eventIndex: (window as any).__fixtureMediaEvents.length };
      }
      return stats;
    };
  };
  await sourcePages[0].evaluate(`(() => { const __name = value => value; (${holdSourceSnapshot.toString()})(); })();`);
  try {
    await sourcePages[0].waitForFunction(() => (window as any).__fixtureSourceStatsGate.waiting, null, { timeout: 6_000 });
    await sourcePages[0].waitForFunction(() => {
      const gate = (window as any).__fixtureSourceStatsGate;
      return gate.newer && (window as any).__fixtureMediaEvents.slice(gate.newer.eventIndex).some((event: any) => event.type === 'media-report' && event.ready);
    }, null, { timeout: 6_000 });
  } finally {
    await sourcePages[0].evaluate(() => { const gate = (window as any).__fixtureSourceStatsGate; gate.release(); gate.restore(); });
  }
  await sourcePages[0].waitForFunction(() => (window as any).__fixtureSourceStatsGate.resumed, null, { timeout: 2_000 });
  await sourcePages[0].waitForTimeout(500);
  const ordered = await request<StudioState>('/state');
  const snapshots = await sourcePages[0].evaluate(() => { const gate = (window as any).__fixtureSourceStatsGate; return { older: gate.older, newer: gate.newer }; });
  console.info('Snapshots natifs délivrés dans l’ordre inverse', JSON.stringify(snapshots));
  assert.equal(ordered.guestRooms![project.id].guests[0].admitted && ordered.guestRooms![project.id].guests[0].sourceReady, true, 'An older native getStats result must not revoke an OBS source after newer decoded frames were confirmed.');
  steps.push(`Snapshots natifs inversés : admission et réception OBS conservées ${JSON.stringify(snapshots)}`);
  await toneProof(guestPages[1], '.guest-programme video', [440, 660], [880], 'Snapshot ancien retardé : retour invité 2 conserve salle + invité 1 sans écho');
  await screenshot(pc, 'nino-invites-pc.png', true); await screenshot(ipad, 'nino-invites-ipad.png', true); await screenshot(guestPages[0], 'nino-invite-en-conversation.png'); await screenshot(bridge, 'nino-liaison-salle.png');
  await ipad.locator('.guest-slot').nth(0).getByRole('button', { name: 'Couper le micro', exact: true }).click();
  await stateWhen(state => !!state.guestRooms![project.id].guests[0].muted && state.obs.inputs.find(input => input.name === guests[0].inputName)?.muted === true, 'Le contrôle iPad coupe réellement le micro dans OBS');
  await toneProof(guestPages[1], '.guest-programme video', [440], [660, 880], 'Micro invité 1 coupé : absent du retour invité 2');
  await toneProof(sourcePages[0], '.guest-source video', [], [440, 660, 880], 'Micro invité 1 coupé : source OBS silencieuse');
  await request<StudioState>('/control', { action: 'guest.scene', guestId: guests[1].id }, deck.token);
  assert.equal(fixture.snapshot().currentScene, guests[1].sceneName); steps.push('Stream Deck affiche le plan invité 2, confirmé par OBS');
  // Hold one genuine native stats result across the removal. This forces the
  // asynchronous callback race without inventing media, reports or RTC values.
  const deferNativeStats = () => {
    const video = document.querySelector('.bridge-guests article video') as HTMLVideoElement;
    const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    const peer = ((window as any).__fixturePeers as RTCPeerConnection[]).find(candidate => candidate.getReceivers().some(receiver => receiver.track === track));
    if (!track || !peer) throw new Error('The removed guest must have a real native receiver in the bridge.');
    const original = peer.getStats; const nativeStats = original.bind(peer);
    const gate = { waiting: false, released: false, resumed: false, peer, release: () => {}, restore: () => { peer.getStats = original; } };
    (window as any).__fixtureStatsGate = gate;
    peer.getStats = async function heldNativeStats() {
      const stats = await nativeStats();
      if (!gate.waiting) {
        gate.waiting = true;
        await new Promise<void>(resolve => { gate.release = () => { gate.released = true; resolve(); }; });
        gate.resumed = true;
      }
      return stats;
    };
  };
  await bridge.evaluate(`(() => { const __name = value => value; (${deferNativeStats.toString()})(); })();`);
  try {
    await bridge.waitForFunction(() => (window as any).__fixtureStatsGate.waiting, null, { timeout: 6_000 });
    await request<StudioState>('/control', { action: 'guest.remove', guestId: guests[0].id }, deck.token);
    await stateWhen(state => state.guestRooms![project.id].guests[0].status === 'removed', 'Stream Deck retire l’invité et révoque ses sessions');
    await bridge.waitForFunction(() => (window as any).__fixtureStatsGate.peer.connectionState === 'closed', null, { timeout: 6_000 });
  } finally {
    await bridge.evaluate(() => { const gate = (window as any).__fixtureStatsGate; gate.release(); gate.restore(); });
  }
  await bridge.waitForFunction(() => { const gate = (window as any).__fixtureStatsGate; return gate.released && gate.resumed; }, null, { timeout: 2_000 });
  steps.push('Retrait pendant getStats natif en attente : résultat réel libéré après fermeture du pair');
  await guestPages[0].getByRole('alert').filter({ hasText: /retiré|expiré/ }).waitFor({ timeout: 10_000 });
  await sourcePages[0].waitForFunction(() => (document.querySelector('.guest-source video') as HTMLVideoElement)?.srcObject === null, null, { timeout: 10_000 });
  await bridge.waitForTimeout(2500);
  await stateWhen(state => {
    const room = state.guestRooms![project.id]; const other = room.guests.find(guest => guest.id === guests[1].id);
    return room.bridge.connected && room.bridge.mediaReady && !!other?.admitted && other.sourceReady && !other.muted;
  }, 'Le retrait du premier invité conserve le pont et le second invité admis dans OBS');
  await liveFrames(guestPages[1], '.guest-programme video', 'Retour invité 2 conservé après retrait invité 1');
  await toneProof(guestPages[1], '.guest-programme video', [440], [660, 880], 'Après retrait invité 1 : retour invité 2 conserve la salle sans écho');
  // Reusing a slot after removal must receive a new one-time source grant.
  // Fake OBS records the same URL update that reloads a real BrowserSource.
  const reinvitation = await request<{ url: string }>(`/projects/${project.id}/guests/invitations`, { slot: 1, name: 'Camille reconnectée' });
  await guestPages[0].goto(reinvitation.url); await guestPages[0].getByRole('button', { name: 'Vérifier caméra et micro', exact: true }).click();
  await liveFrames(guestPages[0], '.guest-programme video', 'Aperçu de la nouvelle invitation');
  await guestPages[0].getByRole('button', { name: 'Rejoindre la salle', exact: true }).click();
  await stateWhen(state => state.guestRooms![project.id].guests[0].joined && state.guestRooms![project.id].guests[0].mediaReady, 'La nouvelle invitation réutilise la place, avec de nouveaux médias');
  await request('/control', { action: 'guest.prepare', projectId: project.id });
  const changedSource = fixture.requests.toReversed().find(request => request.requestType === 'SetInputSettings' && request.requestData.inputName === guests[0].inputName);
  assert.ok(changedSource, 'a removed OBS source session requires a fresh URL');
  await sourcePages[0].goto((changedSource.requestData.inputSettings as { url: string }).url);
  await request('/control', { action: 'guest.admit', guestId: guests[0].id }, deck.token);
  await stateWhen(state => state.guestRooms![project.id].guests[0].admitted && state.guestRooms![project.id].guests[0].sourceReady, 'Nouvelle invitation : réadmission et réception OBS confirmées');
  await liveFrames(sourcePages[0], '.guest-source video', 'Source OBS renouvelée');
  await toneProof(guestPages[1], '.guest-programme video', [440, 660], [880], 'Nouvelle invitation : retour invité 2 rétabli sans écho');
  const publicOrigin = `http://127.0.0.1:${guestPort}`;
  for (const path of ['/api/state', '/api/projects', '/api/devices', '/api/room']) { const response = await fetch(`${publicOrigin}${path}`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(response.status, 404, `guest listener cannot expose ${path}`); }
  assert.equal(await ipad.evaluate(() => (window as any).__fixtureCaptureCount), 0);
  for (const page of sourcePages) assert.equal(await page.evaluate(() => (window as any).__fixtureCaptureCount), 0);
  const bridgeSockets = await bridge.evaluate(() => (window as any).__fixtureSocketEvents);
  assert.equal(bridgeSockets.some((event: { type: string; code?: number }) => event.type === 'error' || event.code === 4003), false,
    `The room bridge must survive guest replacement without a signalling rejection: ${JSON.stringify(bridgeSockets)}`);
  await bridge.getByRole('button', { name: 'Fermer la liaison', exact: true }).click();
  await stateWhen(state => !state.guestRooms![project.id].bridge.connected && state.guestRooms![project.id].guests.every(guest => !guest.admitted)
    && guests.every(guest => state.obs.inputs.find(input => input.name === guest.inputName)?.muted === true), 'Fermeture pont : admissions retirées et micros remis en sourdine dans OBS');
  await guestPages[1].waitForFunction(() => (document.querySelector('.guest-programme video') as HTMLVideoElement)?.srcObject === null, null, { timeout: 10_000 });
  assert.equal(fixture.snapshot().inputs[guests[1].inputName].muted, true);
  assert.deepEqual(failures, [], 'aucune erreur navigateur inattendue');
  if (stun) { assert.ok(stun.count() > 0, 'the browser must use the real STUN UDP responder'); steps.push(`STUN loopback : ${stun.count()} Binding requests réelles`); }
  const playbackErrors = await Promise.all(pages.map(async (page, index) => ({ page: index, errors: await page.evaluate(() => (window as any).__fixtureMediaEvents.filter((event: any) => event.type === 'play-error')) })));
  await writeFile(join(screenshotDir, `nino-guests-${engine}-proof.json`), JSON.stringify({ engine, tabletEngine, sourceEngine, capture: 'synthetic devices, real WebRTC and WebAudio', playbackErrors, steps }, null, 2));
  console.info(JSON.stringify({ engine, tabletEngine, sourceEngine, passed: steps.length, stunBindings: stun?.count() ?? 0, screenshotDir }));
} catch (failure) {
  console.error('Échec de la vérification WebRTC', String(failure).replace(/[a-zA-Z0-9_-]{43}/g, '<token>'));
  console.info('Erreurs navigateur', failures);
  if (stun) console.info('Requêtes STUN réelles', stun.count());
  for (let index = 0; index < pages.length; index++) if (!pages[index].isClosed()) {
    await pages[index].addStyleTag({ content: '.guest-invitation input { color: transparent !important; text-shadow: none !important; }' }).catch(() => undefined);
    await pages[index].screenshot({ path: join(screenshotDir, `failure-${index}.png`) }).catch(() => undefined);
    const body = await pages[index].locator('body').innerText().catch(() => 'indisponible');
    console.info(`Page ${index}`, body.replace(/[a-zA-Z0-9_-]{43}/g, '<token>').slice(-1800));
    console.info(`Capture fixture ${index}`, await pages[index].evaluate(() => ({ stage: (window as any).__fixtureCaptureStage, captureCount: (window as any).__fixtureCaptureCount,
      secure: isSecureContext, fixtureGum: !!navigator.mediaDevices?.getUserMedia?.toString().includes('__fixtureCaptureCount') })));
    console.info(`WS fixture ${index}`, JSON.stringify(await pages[index].evaluate(() => (window as any).__fixtureSocketEvents)));
    const mediaEvents = await pages[index].evaluate(() => (window as any).__fixtureMediaEvents);
    await writeFile(join(screenshotDir, `failure-media-${index}.json`), JSON.stringify(mediaEvents, null, 2));
    console.info(`Media fixture ${index}`, JSON.stringify(mediaEvents.slice(-8)));
    const rtc = await pages[index].evaluate(async () => Promise.all(((window as any).__fixturePeers || []).map(async (peer: RTCPeerConnection) => {
      const stats = await peer.getStats(); const packets: unknown[] = []; stats.forEach(value => { if (['inbound-rtp', 'outbound-rtp', 'candidate-pair'].includes(value.type)) packets.push({ type: value.type, kind: value.kind, state: value.state, selected: value.selected, bytesReceived: value.bytesReceived, bytesSent: value.bytesSent, framesDecoded: value.framesDecoded, framesEncoded: value.framesEncoded }); });
      return { state: peer.connectionState, ice: peer.iceConnectionState, gathering: peer.iceGatheringState, signalling: peer.signalingState,
        tracks: peer.getTransceivers().map(item => ({ mid: item.mid, direction: item.direction, current: item.currentDirection, sender: item.sender.track?.kind, receiver: item.receiver.track.kind, muted: item.receiver.track.muted })), packets };
    }))).catch(() => 'indisponible');
    console.info(`RTC fixture ${index}`, JSON.stringify(rtc));
  }
  throw new Error(String(failure).replace(/[a-zA-Z0-9_-]{43}/g, '<token>'));
} finally {
  await browser?.close(); await tabletBrowser?.close(); await sourceBrowser?.close(); await publicApp?.close().catch(() => undefined); await app?.close().catch(() => undefined); await fixture?.close(); await stun?.close(); await rm(temp, { recursive: true, force: true });
}
