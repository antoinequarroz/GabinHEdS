import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/api/src/app.js';
import { RealMediaGateway } from '../apps/api/src/media.js';
import { startFakeObs } from './fake-obs.js';
import { startTestMedia } from './media-test-server.js';
import type { AuthResult, PreviewSession, StudioState } from '@gabin/shared';

// Bounded verification: real API, OBS adapter, MediaMTX, FFmpeg relay and HLS
// decoding. OBS control and recording are fixtures; no physical capture.
const require = createRequire(import.meta.url);
const bundledModules = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
let playwright: any;
let usesBundledRuntime = false;
if (process.env.GABIN_PLAYWRIGHT_MODULE) playwright = require(process.env.GABIN_PLAYWRIGHT_MODULE);
else {
  try { playwright = require('playwright'); }
  catch (error) {
    if (process.platform !== 'darwin' || !existsSync(bundledModules)) {
      throw new Error('Playwright manque : installez playwright et ses navigateurs, ou indiquez GABIN_PLAYWRIGHT_MODULE.', { cause: error });
    }
    playwright = require(bundledModules);
    usesBundledRuntime = true;
  }
}
const bundledChromium = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const chromiumChannel = process.env.GABIN_CHROMIUM_CHANNEL;
if (chromiumChannel && !['chromium', 'chrome', 'msedge'].includes(chromiumChannel)) throw new Error('Canal Chromium de recette non reconnu.');
const executablePath = process.env.GABIN_CHROMIUM_PATH
  ?? (usesBundledRuntime && !chromiumChannel && existsSync(bundledChromium) ? bundledChromium : undefined);
const browserEngine = process.env.GABIN_TEST_BROWSER ?? 'chromium';
if (!['chromium', 'webkit'].includes(browserEngine)) throw new Error('GABIN_TEST_BROWSER doit être chromium ou webkit.');
const screenshotDir = process.env.GABIN_SCREENSHOT_DIR ?? join(tmpdir(), `gabin-browser-artifacts-${browserEngine}`);
const temp = await mkdtemp(join(tmpdir(), 'gabin-browser-check-'));
let mediaServer: Awaited<ReturnType<typeof startTestMedia>> | undefined;
let fixture: Awaited<ReturnType<typeof startFakeObs>> | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let browser: any;
let pc: any;
let ipad: any;
const steps: string[] = [];
const pageErrors: string[] = [];
const failedApi: string[] = [];
let baseUrl = '';
let token = '';

const track = (page: any) => {
  page.on('pageerror', (error: Error) => pageErrors.push(error.message));
  page.on('response', async (response: any) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      const pathname = new URL(response.url()).pathname.replace(/\/monitor\/[^/]+\//, '/monitor/<session>/');
      failedApi.push(`${response.status()} ${pathname} ${(await response.text().catch(() => '')).slice(0, 500)}`);
    }
  });
};
async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function deckControl(deckToken: string, body: unknown): Promise<StudioState> {
  const response = await fetch(`${baseUrl}/api/control`, { method: 'POST',
    headers: { Authorization: `Bearer ${deckToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<StudioState>;
}
async function untilState(predicate: (state: StudioState) => boolean, description: string): Promise<StudioState> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await api<StudioState>('/state');
    if (predicate(state)) { console.info(`État confirmé : ${description}`); return state; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`État non confirmé : ${description}`);
}
async function noOverflow(page: any, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert(dimensions.scroll <= dimensions.width + 1, `${label}: ${dimensions.scroll}px pour ${dimensions.width}px`);
  steps.push(`${label} : aucun débordement horizontal`);
}
async function decodedProgramme(page: any, label: string): Promise<void> {
  await page.locator('video').waitFor();
  console.info(JSON.stringify({ label, capabilities: await page.locator('video').evaluate((video: HTMLVideoElement) => ({
    nativeHls: video.canPlayType('application/vnd.apple.mpegurl'),
    h264Aac: video.canPlayType('video/mp4; codecs="avc1.42c01e,mp4a.40.2"'),
    mseH264Aac: typeof MediaSource === 'undefined' ? null : MediaSource.isTypeSupported('video/mp4; codecs="avc1.42c01e,mp4a.40.2"'),
    source: video.currentSrc.startsWith('blob:') ? 'MSE' : video.currentSrc ? 'native URL' : 'not assigned',
  })) }));
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video && !video.paused && video.videoWidth === 640 && video.videoHeight === 360
      && video.currentTime > 1 && video.getVideoPlaybackQuality().totalVideoFrames > 10;
  }, null, { timeout: 30_000 });
  const frameHash = () => page.evaluate(() => {
    const video = document.querySelector('video')!;
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36;
    const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0, 64, 36);
    return [...context.getImageData(0, 0, 64, 36).data].reduce((hash, value, index) => ((hash * 31) ^ (value + index)) >>> 0, 0);
  });
  const first = await frameHash();
  await page.waitForTimeout(1200);
  assert.notEqual(await frameHash(), first, `${label} : la mire décodée change réellement`);
  await page.getByRole('button', { name: 'Écouter le retour', exact: true }).click();
  await page.getByRole('button', { name: 'Couper le retour audio', exact: true }).waitFor();
  const audio = await page.locator('video').evaluate((video: HTMLVideoElement & { webkitAudioDecodedByteCount?: number; audioTracks?: { length: number } }) => ({
    muted: video.muted, decodedAudioBytes: video.webkitAudioDecodedByteCount ?? null, paused: video.paused,
    tracks: video.audioTracks?.length ?? null,
  }));
  assert(!audio.muted && !audio.paused, `${label} : lecture avec sortie audio activée`);
  if (browserEngine === 'chromium') assert((audio.decodedAudioBytes ?? 0) > 0, `${label} : AAC décodé`);
  else assert((audio.tracks ?? 0) > 0, `${label} : piste audio HLS native présente`);
  await page.getByRole('button', { name: 'Couper le retour audio', exact: true }).click();
  steps.push(`${label} : HLS réel 640×360, images en mouvement et audio ${browserEngine === 'chromium' ? 'AAC décodé' : 'natif présent'}/activé`);
}

try {
  const testMedia = await startTestMedia(temp);
  mediaServer = testMedia;
  fixture = await startFakeObs({ recordDirectory: join(temp, 'initial-obs'),
    onStreamStart: service => testMedia.startSource(service), onStreamStop: () => testMedia.stopSource() });
  app = await buildApp({ dataDir: join(temp, 'data'), media: new RealMediaGateway(testMedia.options), logger: process.env.GABIN_TEST_LOGGER === '1' });
  await app.listen({ host: browserEngine === 'webkit' ? '0.0.0.0' : '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await playwright[browserEngine].launch({ headless: true,
    ...(browserEngine === 'chromium' ? { args: ['--host-resolver-rules=MAP ipad.gabin.test 127.0.0.1', '--no-proxy-server'],
      ...(executablePath ? { executablePath } : chromiumChannel ? { channel: chromiumChannel } : {}) } : {}) });
  const pcContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  pc = await pcContext.newPage();
  pc.setDefaultTimeout(15_000);
  track(pc);
  await pc.goto(baseUrl);
  await pc.getByRole('heading', { name: 'Vos productions', exact: true }).waitFor();
  token = await pc.evaluate(() => localStorage.getItem('gabin.studio.device'));
  assert(token, 'Jeton technicien créé sur le PC');
  steps.push('PC : connexion locale technicien, interface compilée et WebSocket');

  await pc.locator('.sidebar').getByRole('button', { name: 'Salle et OBS', exact: true }).click();
  await pc.getByLabel('Nom de la salle', { exact: true }).fill('Salle de test Gabin');
  await pc.getByLabel('Adresse du serveur OBS').fill(fixture.url);
  await pc.getByLabel('Dossier des productions sur le PC').fill(join(temp, 'recordings'));
  await pc.getByLabel('Nom de la plateforme', { exact: true }).fill(mediaServer.destination.name);
  await pc.getByLabel('Adresse du serveur RTMP / RTMPS').fill(mediaServer.destination.server);
  await pc.getByLabel(/^Clé de diffusion/).fill(mediaServer.destination.key);
  await pc.getByRole('button', { name: 'Enregistrer la configuration', exact: true }).click();
  await pc.getByRole('button', { name: 'Connecter OBS', exact: true }).click();
  await untilState(state => state.obs.connected && state.obs.scenes.length > 0, 'connexion au protocole OBS');
  await pc.locator('.topbar').getByText('OBS connecté', { exact: true }).waitFor();
  steps.push('Salle : réglages sauvegardés via UI, connexion RealObsGateway → fixture OBS5');

  await pc.locator('.sidebar').getByRole('button', { name: 'Productions', exact: true }).click();
  await pc.getByRole('button', { name: 'Nouvelle production', exact: true }).click();
  await pc.getByLabel('Nom de la production').fill('Métiers de la santé · épisode 01');
  await pc.getByLabel('Responsable', { exact: true }).fill('Équipe HEdS');
  await pc.getByLabel('Description', { exact: true }).fill('Test du parcours PC, iPad et prise OBS.');
  await pc.getByLabel('Scène affichée au démarrage').selectOption('Table ronde');
  await pc.getByRole('button', { name: 'Ajouter une personne', exact: true }).click();
  await pc.getByRole('button', { name: 'Ajouter une personne', exact: true }).click();
  await pc.getByPlaceholder('Participant 1', { exact: true }).fill('Alice');
  await pc.getByPlaceholder('Participant 2', { exact: true }).fill('Benoît');
  const participants = pc.locator('.participant-form');
  await participants.nth(0).getByLabel('Micro').selectOption('Micro 1');
  await participants.nth(1).getByLabel('Micro').selectOption('Micro 2');
  await participants.nth(0).getByLabel('Plan caméra').selectOption('Caméra 1');
  await participants.nth(1).getByLabel('Plan caméra').selectOption('Plan large');
  await pc.getByRole('button', { name: 'Créer le projet', exact: true }).click();
  await pc.getByRole('heading', { name: 'Métiers de la santé · épisode 01', exact: true }).waitFor();
  const created = await untilState(state => state.projects.length === 1, 'projet persistant');
  const projectId = created.projects[0]!.id;
  const preparation = await api<{ canStart: boolean }>(`/preparation/${projectId}`);
  assert(preparation.canStart, 'La préparation autorise la prise');
  await pc.getByRole('button', { name: 'Ouvrir la régie', exact: true }).waitFor();
  await noOverflow(pc, 'PC 1440');
  steps.push('Projet : titre, responsable, description, deux participants, micros et plans enregistrés via UI');
  steps.push('Préparation : contrôles réels API/OBS, dossier accessible et espace disque');

  await pc.locator('.sidebar').getByRole('button', { name: 'Appareils', exact: true }).click();
  await pc.getByRole('button', { name: 'Créer un code d’association', exact: true }).click();
  await pc.locator('.pairing-code').waitFor();
  const pairingCode = (await pc.locator('.pairing-code').textContent()).trim();
  assert(/^\d{6}$/.test(pairingCode), 'Code d’association réel affiché sur le PC');
  const ipadContext = await browser.newContext({ viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  ipad = await ipadContext.newPage();
  ipad.setDefaultTimeout(15_000);
  track(ipad);
  const ipadHost = browserEngine === 'chromium' ? 'ipad.gabin.test' : process.env.GABIN_IPAD_HOST
    ?? Object.values(networkInterfaces()).flat().find(entry => entry && !entry.internal && entry.family === 'IPv4'
      && !entry.address.startsWith('169.254.') && !/^198\.(?:18|19)\./.test(entry.address))?.address;
  assert(ipadHost, 'Une adresse LAN est nécessaire pour tester l’association avec WebKit');
  await ipad.goto(`http://${ipadHost}:${address.port}/#project/${projectId}`);
  await ipad.getByLabel('Nom de cet appareil', { exact: true }).fill('iPad du studio');
  await ipad.getByLabel('Code d’association', { exact: true }).fill(pairingCode);
  await ipad.getByRole('button', { name: 'Rejoindre la salle', exact: true }).click();
  await ipad.getByRole('heading', { name: 'Métiers de la santé · épisode 01', exact: true }).waitFor();
  assert.equal(await ipad.getByRole('button', { name: 'Salle et OBS', exact: true }).count(), 0, 'iPad opérateur sans réglages technicien');
  await noOverflow(ipad, 'iPad 1024');
  steps.push('iPad : association complète via formulaires PC/iPad, accès opérateur, même projet et synchronisation');

  await pc.goto(`${baseUrl}/#project/${projectId}`);
  await pc.getByRole('heading', { name: 'Métiers de la santé · épisode 01', exact: true }).waitFor();
  await pc.getByRole('button', { name: 'Ouvrir la régie', exact: true }).click();
  await pc.getByRole('button', { name: 'Démarrer la prise', exact: true }).click();
  await pc.getByRole('dialog').getByRole('button', { name: 'Démarrer dans OBS', exact: true }).click();
  await untilState(state => state.obs.recording && !!state.activeTake, 'prise démarrée');
  await pc.getByText('Enregistrement · confirmé par OBS', { exact: true }).waitFor();
  await ipad.getByText('Enregistrement · confirmé par OBS', { exact: true }).waitFor();
  assert(fixture.requests.some(request => request.requestType === 'StartRecord'), 'Requête StartRecord passée sur le protocole réel');
  steps.push('Enregistrement : démarrage depuis PC, confirmation OBS et régie visible sur iPad');

  await pc.getByRole('button', { name: 'Activer le retour', exact: true }).click();
  await untilState(state => state.obs.streaming && state.media.previewReady, 'programme reçu par MediaMTX réel');
  if (process.env.GABIN_TEST_LOGGER === '1') {
    const manifest = await fetch(`${mediaServer.options.hlsUrl}/gabin/program/index.m3u8`, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
    console.info(`Manifest MediaMTX : ${manifest.status} ${manifest.headers.get('location') ?? ''} ${(await manifest.text()).slice(0, 1000)}`);
  }
  await decodedProgramme(pc, 'PC');
  await decodedProgramme(ipad, `iPad tactile ${browserEngine}`);
  await pc.getByRole('button', { name: 'Diffuser en direct', exact: true }).click();
  await pc.getByRole('dialog').getByRole('button', { name: 'Diffuser en direct', exact: true }).click();
  await untilState(state => state.media.liveStatus === 'live' && state.media.liveBytes > 0, 'relais FFmpeg envoie le programme');
  assert(await mediaServer.liveReady(), 'Le destinataire RTMP de recette reçoit réellement le live');
  await ipad.getByText('Flux envoyé à la plateforme', { exact: true }).waitFor();
  assert(await pc.getByRole('button', { name: 'Désactiver le retour', exact: true }).isDisabled(), 'Le transport local alimente le live');
  steps.push('Live PC : OBS → RTMP MediaMTX → RTSP FFmpeg → seconde destination RTMP réelle ; iPad synchronisé');

  await ipad.getByRole('button', { name: 'Plan large', exact: true }).click();
  await untilState(state => state.obs.currentScene === 'Plan large', 'changement de scène depuis iPad');
  await pc.locator('.program-header').getByText('Plan large', { exact: true }).waitFor();
  await ipad.getByRole('button', { name: 'Pause', exact: true }).click();
  await untilState(state => state.obs.paused, 'pause depuis iPad');
  await pc.getByRole('button', { name: 'Reprendre', exact: true }).waitFor();
  await pc.getByLabel('Nom du repère', { exact: true }).fill('Bonne réponse à conserver');
  await pc.getByRole('button', { name: 'Ajouter un repère', exact: true }).click();
  await ipad.getByText('Bonne réponse à conserver', { exact: true }).waitFor();
  await pc.getByRole('button', { name: 'Reprendre', exact: true }).click();
  await untilState(state => state.obs.recording && !state.obs.paused && state.markers.length === 1, 'reprise et marqueur');
  await ipad.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  const stopControl = await ipad.getByRole('button', { name: 'Terminer la prise', exact: true }).boundingBox();
  const tabletNavigation = await ipad.locator('.tablet-nav').boundingBox();
  assert(stopControl && tabletNavigation && stopControl.y >= 0 && stopControl.y + stopControl.height <= tabletNavigation.y,
    'Les commandes de prise sont visibles sur iPad sans faire défiler');
  steps.push('Contrôle partagé : iPad change de plan/pause ; PC ajoute repère/reprend ; retours synchronisés');

  await ipad.getByRole('button', { name: 'Arrêter le direct', exact: true }).click();
  await ipad.getByRole('dialog').getByRole('button', { name: 'Arrêter le direct', exact: true }).click();
  const liveStopped = await untilState(state => state.media.liveStatus === 'idle', 'arrêt indépendant du direct iPad');
  assert(liveStopped.obs.recording && liveStopped.obs.streaming && liveStopped.media.previewReady,
    'Arrêter le direct conserve la prise OBS et le retour HLS');
  steps.push('Arrêt du live depuis iPad : prise OBS et retour vidéo conservés');

  const deck = await api<AuthResult>('/devices', { name: 'Stream Deck de recette', kind: 'streamdeck', role: 'operator' });
  const deckCommand = { action: 'stream.start', projectId, requestId: crypto.randomUUID() };
  await Promise.all([deckControl(deck.token, deckCommand), deckControl(deck.token, deckCommand)]);
  await untilState(state => state.media.liveStatus === 'live' && state.media.liveBytes > 0, 'relance du live depuis API Stream Deck');
  assert(await mediaServer.liveReady(), 'Le live Stream Deck arrive à la destination réelle');
  steps.push('Stream Deck : jeton opérateur dédié, commande live API, réessai du même UUID dédupliqué');

  await mkdir(screenshotDir, { recursive: true });
  await pc.locator('.toast').waitFor({ state: 'hidden', timeout: 10_000 });
  for (const page of [pc, ipad]) await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await pc.screenshot({ path: join(screenshotDir, 'gabin-studio-pc.png'), fullPage: true });
  await ipad.screenshot({ path: join(screenshotDir, 'gabin-studio-ipad.png'), fullPage: true });

  await ipad.getByRole('button', { name: 'Terminer la prise', exact: true }).click();
  await ipad.getByRole('dialog').getByRole('button', { name: 'Terminer et conserver la prise', exact: true }).click();
  const ended = await untilState(state => !state.obs.recording && !state.activeTake && state.takes[0]?.status === 'completed', 'prise terminée');
  assert.equal(ended.media.liveStatus, 'live', 'Terminer la prise ne coupe pas le direct');
  assert(await mediaServer.liveReady(), 'Le destinataire reçoit toujours le direct après StopRecord');
  await deckControl(deck.token, { action: 'stream.stop' });
  await untilState(state => state.media.liveStatus === 'idle' && state.media.previewReady, 'arrêt live Stream Deck, retour conservé');
  assert(ended.takes[0]!.outputPath && existsSync(ended.takes[0]!.outputPath!), 'Fichier de sortie fixture présent');
  await ipad.getByRole('heading', { name: 'Les prises de cette production', exact: true }).waitFor();
  await pc.getByRole('button', { name: /Retrouver les prises/ }).click();
  await pc.getByText('Terminée', { exact: true }).waitFor();
  await ipad.getByText('Terminée', { exact: true }).waitFor();
  assert(fixture.requests.some(request => request.requestType === 'StopRecord'), 'StopRecord passé sur le protocole réel');
  steps.push('Arrêt iPad : confirmation OBS, historique PC/iPad, chemin et fichier persistés');

  if (process.env.GABIN_SKIP_DOWNLOAD !== '1') {
    const pendingDownload = pc.waitForEvent('download');
    await pc.getByRole('button', { name: 'Télécharger le fichier', exact: true }).click();
    const download = await pendingDownload;
    const saved = join(temp, 'download.mkv');
    await download.saveAs(saved);
    assert((await readFile(saved, 'utf8')).includes('TEST FIXTURE'), 'Téléchargement complet correspond au fichier OBS de test');
    steps.push('Récupération : téléchargement navigateur complet via ticket autorisé, fichier identique');
  }

  await noOverflow(ipad, 'Prises iPad 1024');
  for (const width of [768, 390]) {
    await ipad.setViewportSize({ width, height: 900 });
    await noOverflow(ipad, `Prises ${width}`);
    await ipad.getByRole('button', { name: /Préparer la salle/ }).click();
    await noOverflow(ipad, `Préparation ${width}`);
    await ipad.getByRole('button', { name: /Enregistrer et diffuser$/ }).click();
    await noOverflow(ipad, `Régie ${width}`);
    await ipad.getByRole('button', { name: /Retrouver les prises/ }).click();
  }
  assert.deepEqual(pageErrors, [], 'Aucune exception JavaScript navigateur');
  assert.deepEqual(failedApi, [], 'Aucune requête API échouée pendant le parcours');
  const previewResponse = await fetch(`${baseUrl}/api/monitor/session`, { method: 'POST', headers: { Authorization: `Bearer ${deck.token}` } });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json() as PreviewSession;
  const playlist = await fetch(`${baseUrl}${preview.url}`);
  assert.equal(playlist.status, 200);
  assert.match(await playlist.text(), /^#EXTM3U/);
  const anonymous = await fetch(`${baseUrl}/api/monitor/session`, { method: 'POST' });
  assert.equal(anonymous.status, 401, 'La session vidéo exige un appareil autorisé');
  const revoked = await fetch(`${baseUrl}/api/devices/${deck.device.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(revoked.status, 204);
  const rejected = await fetch(`${baseUrl}/api/state`, { headers: { Authorization: `Bearer ${deck.token}` } });
  assert.equal(rejected.status, 401, 'La révocation du Stream Deck s’applique aux commandes et états');
  const rejectedHls = await fetch(`${baseUrl}${preview.url}`);
  assert.equal(rejectedHls.status, 401, 'La révocation invalide aussi une session HLS déjà émise');
  steps.push('Retour vidéo : HLS proxifié avec session authentifiée ; Stream Deck révocable');
  console.log(JSON.stringify({ passed: true, steps, pageErrors, failedApi, screenshots: [join(screenshotDir, 'gabin-studio-pc.png'), join(screenshotDir, 'gabin-studio-ipad.png')] }, null, 2));
} catch (error) {
  await mkdir(screenshotDir, { recursive: true });
  if (pc) await pc.screenshot({ path: join(screenshotDir, 'gabin-studio-failure-pc.png'), fullPage: true }).catch(() => undefined);
  if (ipad) await ipad.screenshot({ path: join(screenshotDir, 'gabin-studio-failure-ipad.png'), fullPage: true }).catch(() => undefined);
  const videoStates = await Promise.all([pc, ipad].map(page => page?.locator('video').evaluateAll((videos: HTMLVideoElement[]) => videos.map(video => ({
    readyState: video.readyState, width: video.videoWidth, height: video.videoHeight, time: video.currentTime,
    paused: video.paused, muted: video.muted, error: video.error?.code ?? null,
    quality: typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null,
  }))).catch(() => undefined)));
  console.error(JSON.stringify({ passed: false, steps, pageErrors, failedApi, videoStates, error: error instanceof Error ? error.stack : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  // A failed browser/service startup still releases every test-owned child and
  // database. One failing cleanup must not skip the subsequent resources.
  const closeResource = async (close: () => Promise<unknown> | undefined) => {
    try { await close(); }
    catch (error) {
      console.error('Nettoyage de la recette incomplet :', error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
  await Promise.allSettled([closeResource(() => browser?.close()), closeResource(() => app?.close())]);
  await closeResource(() => fixture?.close());
  await closeResource(() => mediaServer?.close());
  await rm(temp, { recursive: true, force: true });
}
