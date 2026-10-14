import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/api/src/app.js';
import { RealMediaGateway } from '../apps/api/src/media.js';
import { startFakeObs } from './fake-obs.js';
import { startTestMedia } from './media-test-server.js';
import { createMediaFixture } from './media-fixture.js';
import { decodedImagePreviews, noOverflow as assertNoOverflow, proofScreenshot as captureProof,
  verifyRenderingGuards } from './browser-rendering.js';
import type { AuthResult, MediaAsset, PreviewSession, StudioState } from '@gabin/shared';

// Bounded verification: real API, OBS adapter, MediaMTX, FFmpeg relay and HLS
// decoding. OBS control and recording are fixtures; no physical capture.
const require = createRequire(import.meta.url);
const execute = promisify(execFile);
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
let meterTimer: ReturnType<typeof setInterval> | undefined;
let meterLevels: [number, number] = [-65, -65];
const steps: string[] = [];
const pageErrors: string[] = [];
const failedApi: string[] = [];
let baseUrl = '';
let token = '';

const track = (page: any) => {
  page.on('pageerror', (error: Error) => pageErrors.push(error.message));
  page.on('response', async (response: any) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      const pathname = new URL(response.url()).pathname.replace(/\/(monitor|library-files|playback-files|production-exports|resolve-exports|downloads)\/[^/]+/, '/$1/<session>');
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
  await assertNoOverflow(page, label);
  steps.push(`${label} : aucun débordement horizontal`);
}
async function proofScreenshot(page: any, filename: string): Promise<void> {
  const started = Date.now();
  const captures = await captureProof(page, join(screenshotDir, filename), browserEngine === 'webkit');
  console.info(`Capture confirmée : ${filename}, ${captures.length} vue(s) (${Date.now() - started} ms)`);
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
  const encodedFixture = await createMediaFixture(join(temp, 'fixtures'));
  const testMedia = await startTestMedia(temp);
  mediaServer = testMedia;
  fixture = await startFakeObs({ recordDirectory: join(temp, 'initial-obs'),
    meters: false,
    recordingFixture: encodedFixture.mkv,
    onStreamStart: service => testMedia.startSource(service), onStreamStop: () => testMedia.stopSource() });
  // Publish OBS5 InputVolumeMeters events at real intervals with deliberately
  // separate microphone levels. Automatic cuts must cross the actual gateway,
  // queue and authenticated API; no Studio state is forged by this test.
  meterTimer = setInterval(() => fixture!.emitMeters(meterLevels.map((db, index) => ({ inputName: `Micro ${index + 1}`,
    inputLevelsMul: [[10 ** (db / 20), 10 ** ((db + 2) / 20), 10 ** ((db + 2) / 20)]] }))), 125);
  meterTimer.unref();
  app = await buildApp({ dataDir: join(temp, 'data'), media: new RealMediaGateway(testMedia.options), logger: process.env.GABIN_TEST_LOGGER === '1' });
  await app.listen({ host: browserEngine === 'webkit' ? '0.0.0.0' : '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await playwright[browserEngine].launch({ headless: true,
    ...(browserEngine === 'chromium' ? { args: ['--host-resolver-rules=MAP ipad.gabin.test 127.0.0.1', '--no-proxy-server'],
      ...(executablePath ? { executablePath } : chromiumChannel ? { channel: chromiumChannel } : {}) } : {}) });
  await verifyRenderingGuards(browser);
  steps.push('Gardes du test : débordement réel de 420 px rejeté à 390 px ; aperçu manquant rejeté, images valides décodées');
  const pcContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  pc = await pcContext.newPage();
  pc.setDefaultTimeout(15_000);
  track(pc);
  await pc.goto(baseUrl);
  await pc.getByRole('heading', { name: 'Vos productions', exact: true }).waitFor();
  console.info(`Interface compilée chargée : ${await pc.locator('script[type="module"][src]').getAttribute('src')}`);
  token = await pc.evaluate(() => localStorage.getItem('gabin.studio.device'));
  assert(token, 'Jeton technicien créé sur le PC');
  steps.push('PC : connexion locale technicien, interface compilée et WebSocket');

  await pc.locator('.sidebar').getByRole('button', { name: 'Salle et OBS', exact: true }).click();
  await pc.getByLabel('Nom de la salle', { exact: true }).fill('Salle de test Nino');
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
  await participants.nth(1).getByLabel('Plan caméra').selectOption('Caméra 2');
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

  await pc.goto(`${baseUrl}/#library`);
  await pc.getByLabel('Fichiers à importer').setInputFiles(encodedFixture.mp4);
  const videoImported = await untilState(state => !!state.library?.some(asset => asset.originalName === 'intro-test.mp4'), 'vidéo importée depuis le PC');
  const videoAsset = videoImported.library!.find(asset => asset.originalName === 'intro-test.mp4')!;
  assert.equal(videoAsset.kind, 'video');
  assert((videoAsset.durationMs ?? 0) >= 3900, 'Métadonnées de la vraie vidéo importée');
  await pc.getByText(videoAsset.title, { exact: true }).first().waitFor();
  await ipad.goto(new URL('/#library', ipad.url()).href);
  await ipad.getByLabel('Fichiers à importer').setInputFiles(encodedFixture.image);
  const imageImported = await untilState(state => state.library?.length === 2, 'image importée depuis iPad');
  const imageAsset = imageImported.library!.find(asset => asset.originalName === 'logo-test.png')!;
  assert.equal(imageAsset.kind, 'image');
  await pc.getByText(imageAsset.title, { exact: true }).first().waitFor();
  await ipad.getByText(videoAsset.title, { exact: true }).first().waitFor();
  await noOverflow(pc, 'Bibliothèque PC');
  await noOverflow(ipad, 'Bibliothèque iPad');
  await mkdir(screenshotDir, { recursive: true });
  await decodedImagePreviews(pc, '.media-asset-card img', 2);
  await proofScreenshot(pc, 'nino-library-pc.png');
  await decodedImagePreviews(ipad, '.media-asset-card img', 2);
  await proofScreenshot(ipad, 'nino-library-ipad.png');
  steps.push('Bibliothèque : vrais imports MP4 sur PC et PNG sur iPad, métadonnées vérifiées et catalogue partagé');

  await pc.goto(`${baseUrl}/#project/${projectId}`);
  await pc.getByRole('heading', { name: 'Métiers de la santé · épisode 01', exact: true }).waitFor();
  await pc.getByLabel('Média à associer', { exact: true }).selectOption(videoAsset.id);
  await pc.getByLabel('Rôle du média', { exact: true }).selectOption('intro');
  await pc.getByRole('button', { name: 'Ajouter le média', exact: true }).click();
  await untilState(state => state.projectMedia?.[projectId]?.length === 1, 'intro associée');
  await pc.getByLabel('Média à associer', { exact: true }).selectOption(imageAsset.id);
  await pc.getByLabel('Rôle du média', { exact: true }).selectOption('logo');
  await pc.getByRole('button', { name: 'Ajouter le média', exact: true }).click();
  await untilState(state => state.projectMedia?.[projectId]?.length === 2, 'logo associé');
  await ipad.bringToFront();
  await ipad.goto(new URL(`/#project/${projectId}`, ipad.url()).href);
  await ipad.getByRole('heading', { name: 'Métiers de la santé · épisode 01', exact: true }).waitFor();
  await ipad.getByRole('button', { name: 'Enregistrer et diffuser', exact: true }).click();
  await pc.getByRole('button', { name: 'Ouvrir la régie', exact: true }).click();
  const pcAutomatic = pc.getByRole('region', { name: 'Réalisation automatique', exact: true });
  const ipadAutomatic = ipad.getByRole('region', { name: 'Réalisation automatique', exact: true });
  await pcAutomatic.getByLabel('Plan large', { exact: true }).selectOption('Plan large');
  await pcAutomatic.getByText('Réglages de détection', { exact: true }).click();
  await pcAutomatic.getByLabel('Confirmation de parole (ms)', { exact: true }).fill('300');
  await pcAutomatic.getByLabel('Durée minimale d’un plan (ms)', { exact: true }).fill('1000');
  await pcAutomatic.getByLabel('Retour au plan large après silence (ms)', { exact: true }).fill('1500');
  await pcAutomatic.getByLabel('Confirmation des voix simultanées (ms)', { exact: true }).fill('500');
  await pcAutomatic.getByRole('button', { name: 'Enregistrer la détection', exact: true }).click();
  const configuredAutomatic = await untilState(state => state.autoDirectionSettings?.[projectId]?.minShotMs === 1000, 'réglages automatiques sauvegardés depuis PC');
  assert.equal(configuredAutomatic.autoDirection?.enabled, false, 'La configuration seule ne lance pas la réalisation');
  await proofScreenshot(pc, 'nino-auto-settings-pc.png');
  await pcAutomatic.getByText('Réglages de détection', { exact: true }).click();
  await pcAutomatic.getByRole('button', { name: 'Activer l’automatique', exact: true }).click();
  const armedAutomatic = await untilState(state => !!state.autoDirection?.enabled && state.autoDirection.projectId === projectId, 'activation automatique PC');
  assert(!armedAutomatic.obs.recording && !armedAutomatic.obs.streaming, 'Activer l’automatique ne démarre aucun enregistrement ni diffusion');
  steps.push('Automatique PC : association micros/plans distincts et plan large, réglages bornés via formulaire, activation sans démarrage des sorties');
  await pc.getByRole('button', { name: 'Démarrer la prise', exact: true }).click();
  await pc.getByRole('dialog').getByRole('button', { name: 'Démarrer dans OBS', exact: true }).click();
  await untilState(state => state.obs.recording && !!state.activeTake, 'prise démarrée');
  await pc.getByText('Enregistrement · confirmé par OBS', { exact: true }).waitFor();
  await ipad.getByText('Enregistrement · confirmé par OBS', { exact: true }).waitFor();
  assert(fixture.requests.some(request => request.requestType === 'StartRecord'), 'Requête StartRecord passée sur le protocole réel');
  steps.push('Enregistrement : démarrage depuis PC, confirmation OBS et régie visible sur iPad');

  const deck = await api<AuthResult>('/devices', { name: 'Stream Deck de recette', kind: 'streamdeck', role: 'operator' });
  meterLevels = [-20, -65];
  const directed = await untilState(state => state.obs.currentScene === 'Caméra 1' && state.autoDirection?.status === 'listening'
    && state.sceneChanges?.some(change => change.takeId === state.activeTake?.id && change.reason === 'speaker'), 'Alice choisit Caméra 1 via ses vraies mesures OBS');
  const firstSpeakerCut = directed.sceneChanges!.find(change => change.takeId === directed.activeTake!.id && change.reason === 'speaker')!;
  assert.equal(firstSpeakerCut.participantId, created.projects[0]!.participants[0]!.id);
  assert(firstSpeakerCut.offsetMs !== null && firstSpeakerCut.offsetMs > 0, 'Journal de changement confirmé au temps réel de la prise');
  assert(fixture.requests.some(request => request.requestType === 'SetCurrentProgramScene' && request.requestData.sceneName === 'Caméra 1'), 'Le changement automatique est envoyé sur le protocole OBS');
  await pc.locator('.program-header').getByText('Caméra 1', { exact: true }).waitFor();
  await ipadAutomatic.getByRole('button', { name: 'Revenir en manuel', exact: true }).waitFor();
  await noOverflow(pc, 'Réalisation automatique PC');
  await noOverflow(ipad, 'Réalisation automatique iPad');
  await pc.bringToFront();
  await pcAutomatic.getByRole('heading', { name: 'Réalisation automatique', exact: true }).scrollIntoViewIfNeeded();
  await pc.locator('.toast').waitFor({ state: 'hidden', timeout: 10_000 });
  await proofScreenshot(pc, 'nino-auto-pc.png');
  await pcAutomatic.screenshot({ path: join(screenshotDir, 'nino-auto-pc-detail.png'), animations: 'disabled', timeout: 45_000 });
  await ipad.bringToFront();
  await ipadAutomatic.getByRole('heading', { name: 'Réalisation automatique', exact: true }).scrollIntoViewIfNeeded();
  await ipad.locator('.toast').waitFor({ state: 'hidden', timeout: 10_000 });
  await proofScreenshot(ipad, 'nino-auto-ipad.png');
  // A second static tablet posture gives the guide a complete painted card,
  // including the manual override button. Do not resize the tested iPad view
  // or hide the actual fixed transport to make a screenshot look complete.
  const portraitContext = await browser.newContext({ viewport: { width: 1024, height: 1366 }, isMobile: true, hasTouch: true,
    storageState: await ipadContext.storageState() });
  try {
    const portrait = await portraitContext.newPage();
    portrait.setDefaultTimeout(15_000); track(portrait);
    await portrait.goto(new URL(`/#project/${projectId}`, ipad.url()).href);
    await portrait.getByRole('heading', { name: 'Métiers de la santé · épisode 01', exact: true }).waitFor();
    const portraitAutomatic = portrait.getByRole('region', { name: 'Réalisation automatique', exact: true });
    await portraitAutomatic.getByRole('button', { name: 'Revenir en manuel', exact: true }).waitFor();
    await portraitAutomatic.getByRole('heading', { name: 'Réalisation automatique', exact: true }).scrollIntoViewIfNeeded();
    await noOverflow(portrait, 'Réalisation automatique iPad portrait');
    await proofScreenshot(portrait, 'nino-auto-ipad-portrait.png');
    await portraitAutomatic.screenshot({ path: join(screenshotDir, 'nino-auto-ipad-detail.png'), animations: 'disabled', timeout: 45_000 });
  } finally { await portraitContext.close(); }
  await ipad.getByRole('button', { name: 'Caméra 2', exact: true }).click();
  await untilState(state => state.obs.currentScene === 'Caméra 2' && state.autoDirection?.status === 'suspended' && !state.autoDirection.enabled, 'choix manuel iPad suspend l’automatique');
  await pc.waitForTimeout(1300);
  assert.equal((await api<StudioState>('/state')).obs.currentScene, 'Caméra 2', 'Les micros ne combattent pas le plan choisi manuellement');
  await pcAutomatic.getByRole('button', { name: 'Reprendre l’automatique', exact: true }).click();
  await untilState(state => state.obs.currentScene === 'Caméra 1' && !!state.autoDirection?.enabled, 'reprise explicite depuis PC');
  await ipadAutomatic.getByRole('button', { name: 'Revenir en manuel', exact: true }).click();
  await untilState(state => state.autoDirection?.status === 'off' && !state.autoDirection.enabled, 'arrêt automatique depuis iPad');
  const automaticSettings = { ...configuredAutomatic.autoDirectionSettings![projectId]!, thresholdDb: -36 };
  await deckControl(deck.token, { action: 'auto.configure', projectId, settings: automaticSettings });
  meterLevels = [-65, -20];
  const automaticDeckStart = { action: 'auto.start', projectId, requestId: crypto.randomUUID() };
  await Promise.all([deckControl(deck.token, automaticDeckStart), deckControl(deck.token, automaticDeckStart)]);
  await untilState(state => state.obs.currentScene === 'Caméra 2' && state.autoDirection?.participantId === created.projects[0]!.participants[1]!.id,
    'Benoît choisit Caméra 2 après activation Stream Deck dédupliquée');
  await deckControl(deck.token, { action: 'auto.stop' });
  await untilState(state => state.autoDirection?.status === 'off' && !state.autoDirection.enabled, 'retour manuel Stream Deck');
  assert.equal(fixture.requests.filter(request => request.requestType === 'StartRecord').length, 1, 'La régie automatique n’a pas relancé la prise');
  assert.equal(fixture.requests.filter(request => request.requestType === 'StartStream').length, 0, 'La régie automatique n’a pas démarré de diffusion');
  await pc.getByRole('button', { name: 'Table ronde', exact: true }).click();
  await untilState(state => state.obs.currentScene === 'Table ronde', 'retour au plan initial après recette automatique');
  meterLevels = [-65, -65];
  steps.push('Automatique PC/iPad/Stream Deck : voix OBS -> plan confirmé et journal de prise ; priorité au choix manuel, reprise explicite, configuration/activation/arrêt authentifiés et réessai dédupliqué');
  await pc.getByRole('button', { name: `Lancer ${videoAsset.title}`, exact: true }).click();
  await untilState(state => state.mediaPlayback?.assetId === videoAsset.id && state.mediaPlayback.status === 'playing', 'intro confirmée par OBS');
  await ipad.getByRole('button', { name: 'Mettre le média en pause', exact: true }).click();
  await untilState(state => state.mediaPlayback?.status === 'paused', 'pause média depuis iPad');
  await pc.getByRole('button', { name: 'Reprendre le média', exact: true }).click();
  await untilState(state => state.mediaPlayback?.status === 'playing', 'reprise média depuis PC');
  fixture.finishMedia();
  await untilState(state => state.mediaPlayback?.status === 'stopped' && state.obs.currentScene === 'Nino · Médias', 'fin naturelle du clip confirmée par OBS');
  await pc.getByRole('button', { name: 'Revenir au plan précédent', exact: true }).waitFor();
  await deckControl(deck.token, { action: 'media.stop' });
  await untilState(state => state.mediaPlayback?.status === 'stopped' && state.obs.currentScene === 'Table ronde', 'arrêt Stream Deck et retour scène précédente');
  const imageCommand = { action: 'media.play', assetId: imageAsset.id, projectId, mode: 'overlay', requestId: crypto.randomUUID() };
  await Promise.all([deckControl(deck.token, imageCommand), deckControl(deck.token, imageCommand)]);
  await untilState(state => state.mediaPlayback?.assetId === imageAsset.id && state.mediaPlayback.status === 'shown', 'logo Stream Deck confirmé');
  await ipad.getByRole('button', { name: 'Masquer le média', exact: true }).click();
  const afterMedia = await untilState(state => state.mediaPlayback?.status === 'stopped', 'arrêt logo depuis iPad');
  assert(afterMedia.obs.recording, 'Contrôler les médias conserve la capture OBS');
  assert(fixture.requests.some(request => request.requestType === 'GetMediaInputStatus'), 'La lecture est confirmée sur le protocole OBS');
  steps.push('Médias en régie : vidéo lancée PC, pause iPad/reprise PC, arrêt et logo depuis API Stream Deck, capture conservée');

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
  await proofScreenshot(pc, 'gabin-studio-pc.png');
  await proofScreenshot(ipad, 'gabin-studio-ipad.png');

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
    assert.deepEqual(await readFile(saved), await readFile(encodedFixture.mkv), 'Téléchargement complet correspond exactement au fichier de mire encodée retourné par OBS de test');
    steps.push('Récupération : téléchargement navigateur complet via ticket autorisé, fichier identique');
  }

  await pc.getByRole('button', { name: 'Lire la prise', exact: true }).click();
  await pc.locator('.take-player video').waitFor({ timeout: 30_000 });
  await pc.locator('.take-player video').evaluate((video: HTMLVideoElement) => { video.muted = true; return video.play(); });
  await pc.waitForFunction(() => { const video = document.querySelector('.take-player video') as HTMLVideoElement | null; return video && video.videoWidth === 640 && video.currentTime > 0.2; });
  await ipad.getByRole('button', { name: 'Lire la prise', exact: true }).click();
  await ipad.locator('.take-player video').waitFor({ timeout: 30_000 });
  await ipad.locator('.take-player video').evaluate((video: HTMLVideoElement) => { video.muted = true; return video.play(); });
  await ipad.waitForFunction(() => { const video = document.querySelector('.take-player video') as HTMLVideoElement | null; return video && video.videoWidth === 640 && video.currentTime > 0.2; });
  steps.push('Lecture des prises : original MKV converti/remuxé pour lecture MP4 décodée sur PC et iPad');
  await proofScreenshot(pc, 'nino-production-files-pc.png');
  await proofScreenshot(ipad, 'nino-production-files-ipad.png');
  await proofScreenshot(pc, 'nino-resolve-pc.png');
  await proofScreenshot(ipad, 'nino-resolve-ipad.png');
  if (process.env.GABIN_SKIP_DOWNLOAD !== '1') {
    const pendingArchive = pc.waitForEvent('download');
    await pc.getByRole('button', { name: 'Récupérer le dossier complet', exact: true }).click();
    const archive = await pendingArchive;
    const saved = join(temp, 'production.zip');
    await archive.saveAs(saved);
    const { stdout } = await execute('unzip', ['-Z1', saved], { timeout: 10_000 });
    const names = stdout.trim().split('\n');
    assert(names.some(name => name.endsWith('project.json')), 'Métadonnées projet présentes');
    assert(names.some(name => name.endsWith('markers.json')), 'Repères de montage présents');
    assert(names.some(name => name.endsWith('manifest.json')), 'Manifest du dossier présent');
    for (const [extension, original] of [['.mkv', encodedFixture.mkv], ['.mp4', encodedFixture.mp4], ['.png', encodedFixture.image]] as const) {
      const entry = names.find(name => name.endsWith(extension));
      assert(entry, `Fichier ${extension} présent dans le dossier complet`);
      const extracted = await execute('unzip', ['-p', saved, entry], { encoding: 'buffer', timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
      assert.deepEqual(extracted.stdout, await readFile(original), `Original ${extension} conservé intégralement`);
    }
    assert(!names.some(name => /sqlite|\.env|token/i.test(name)), 'Aucun fichier privé dans l’archive');
    steps.push('Dossier complet : ZIP navigateur contenant prises originales, médias associés, projet et repères, octets identiques');

    const pendingResolve = pc.waitForEvent('download', { timeout: 45_000 });
    await pc.getByRole('button', { name: 'Télécharger pour DaVinci Resolve', exact: true }).click();
    const resolveDownload = await pendingResolve;
    assert.equal(await resolveDownload.failure(), null, 'Le téléchargement Resolve aboutit réellement dans le navigateur');
    const resolveZip = join(temp, 'resolve.zip');
    await resolveDownload.saveAs(resolveZip);
    const { stdout: resolveNamesText } = await execute('unzip', ['-Z1', resolveZip], { timeout: 10_000 });
    const resolveNames = resolveNamesText.trim().split('\n');
    const readResolveEntry = async (name: string): Promise<Buffer> => {
      assert(resolveNames.includes(name), `Entrée Resolve présente : ${name}`);
      return (await execute('unzip', ['-p', resolveZip, name], { encoding: 'buffer', timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
    };
    const resolveConfig = JSON.parse((await readResolveEntry('resolve-project.json')).toString());
    assert.equal(resolveConfig.projectId, projectId);
    assert.equal(resolveConfig.isolatedCameras, false, 'L’export ne promet pas d’angles caméra séparés');
    assert.equal(resolveConfig.timelines.length, 1);
    const resolveEntry = resolveConfig.timelines[0];
    assert.equal(resolveEntry.takeId, ended.takes[0]!.id);
    assert.equal(resolveEntry.frameRate, 25);
    assert.equal(resolveEntry.frames, 100, 'Timeline de la vidéo complète de mire 4s/25fps');
    const timeline = JSON.parse((await readResolveEntry(resolveEntry.file)).toString());
    assert.equal(timeline.OTIO_SCHEMA, 'Timeline.1');
    assert.equal(timeline.metadata.Nino.sceneChanges, 'markers_only');
    assert.equal(timeline.tracks.children.length, 2, 'Vidéo entière et son lié inclus');
    for (const track of timeline.tracks.children) {
      assert.equal(track.children.length, 1, 'Aucun passage de la prise n’est supprimé');
      const clip = track.children[0];
      assert.equal(clip.source_range.start_time.value, 0);
      assert.equal(clip.source_range.duration.value, 100);
      assert.equal(clip.metadata.Resolve_OTIO['Link Group ID'], 1);
      assert.equal(clip.media_references.DEFAULT_MEDIA.target_url, resolveEntry.mediaFile);
    }
    const programMp4 = await readResolveEntry(resolveEntry.mediaFile);
    assert(programMp4.subarray(0, 32).includes(Buffer.from('ftyp')), 'Programme MP4 préparé réellement présent');
    const exportedJournal = JSON.parse((await readResolveEntry('scene-changes.json')).toString()).changes;
    const finalState = await api<StudioState>('/state');
    assert.deepEqual(exportedJournal, finalState.sceneChanges!.filter(change => change.projectId === projectId), 'Journal réel de tous les changements de la production conservé');
    assert(exportedJournal.some((change: any) => change.reason === 'speaker' && change.participantId === firstSpeakerCut.participantId), 'Repères de réalisation automatique conservés dans le dossier');
    const durationMs = resolveEntry.frames / resolveEntry.frameRate * 1000;
    const validOffsets = [...exportedJournal.filter((change: any) => change.takeId === ended.takes[0]!.id).map((change: any) => change.offsetMs),
      ...finalState.markers.filter(marker => marker.takeId === ended.takes[0]!.id).map(marker => marker.offsetMs)]
      .filter((offset: unknown): offset is number => typeof offset === 'number' && Number.isFinite(offset) && offset >= 0 && offset < durationMs);
    const expectedFrames = [...new Set(validOffsets.map(offset => Math.min(resolveEntry.frames - 1, Math.round(offset / 1000 * resolveEntry.frameRate))))].sort((a, b) => a - b);
    assert.deepEqual(timeline.tracks.markers.map((marker: any) => marker.marked_range.start_time.value), expectedFrames,
      'Les timecodes valides deviennent exactement les repères OTIO ; hors prise, pauses ou au-delà du fichier restent exclus');
    assert(timeline.tracks.markers.some((marker: any) => marker.color === 'GREEN'), 'Scène initiale confirmée représentée dans Resolve');
    const originalTakeEntry = resolveNames.find(name => name.startsWith('takes/') && name.endsWith('.mkv'))!;
    assert.deepEqual(await readResolveEntry(originalTakeEntry), await readFile(encodedFixture.mkv), 'Original OBS inchangé également récupéré avec l’export Resolve');
    assert(resolveNames.includes('IMPORTER_DANS_RESOLVE.txt') && resolveNames.includes('import-nino-resolve.py'), 'Instructions et script portable fournis');
    const safeMetadata = JSON.stringify({ config: resolveConfig, timeline, changes: exportedJournal });
    for (const secret of [temp, token, deck.token]) assert.equal(safeMetadata.includes(secret), false, 'Aucun chemin local ni jeton dans les métadonnées portables');
    steps.push('DaVinci Resolve : téléchargement ZIP réel depuis UI, original inchangé, MP4 préparé, timeline OTIO complète vidéo+son liés, journal et repères exacts sans angles caméra inventés');
  }

  await noOverflow(ipad, 'Prises iPad 1024');
  const ipadStorage = await ipadContext.storageState();
  const ipadOrigin = new URL(ipad.url()).origin;
  // Static device sizes get their own mobile render view. Repeatedly resizing
  // one WebKit fixed-layout view can retain the previous device's scrollport.
  for (const width of [768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true,
      acceptDownloads: true, storageState: ipadStorage });
    try {
      const mobile = await context.newPage();
      mobile.setDefaultTimeout(15_000);
      track(mobile);
      await mobile.goto(`${ipadOrigin}/#project/${projectId}`);
      await mobile.getByRole('heading', { name: 'Métiers de la santé · épisode 01', exact: true }).waitFor();
      await mobile.getByRole('button', { name: /Retrouver les prises/ }).click();
      await mobile.getByRole('heading', { name: 'Les prises de cette production', exact: true }).waitFor();
      await noOverflow(mobile, `Prises ${width}`);
      await mobile.getByRole('button', { name: /Préparer la salle/ }).click();
      await mobile.getByRole('heading', { name: 'Participants et plans', exact: true }).waitFor();
      await noOverflow(mobile, `Préparation ${width}`);
      await mobile.getByRole('button', { name: /Enregistrer et diffuser$/ }).click();
      await mobile.getByRole('heading', { name: 'Changer de plan', exact: true }).waitFor();
      await noOverflow(mobile, `Régie ${width}`);
      await mobile.getByRole('button', { name: /Retrouver les prises/ }).click();
      await mobile.goto(`${ipadOrigin}/#library`);
      await mobile.getByRole('heading', { name: 'Bibliothèque de médias', exact: true }).waitFor();
      await noOverflow(mobile, `Bibliothèque ${width}`);
      await decodedImagePreviews(mobile, '.media-asset-card img', 2);
      await proofScreenshot(mobile, `nino-library-${width}.png`);
    } catch (error) {
      const [mobile] = context.pages();
      if (mobile) await captureProof(mobile, join(screenshotDir, `nino-mobile-failure-${width}.png`), browserEngine === 'webkit').catch(() => undefined);
      throw error;
    } finally {
      await context.close();
    }
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
  await pc.goto(`${baseUrl}/#devices`);
  const deckRow = pc.locator('.device-row').filter({ hasText: 'Stream Deck de recette' });
  await deckRow.getByRole('button', { name: 'Révoquer', exact: true }).click();
  await pc.getByRole('dialog').getByRole('button', { name: 'Révoquer l’accès', exact: true }).click();
  await pc.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(failedApi, [], 'La révocation depuis l’interface utilise une requête valide');
  const rejected = await fetch(`${baseUrl}/api/state`, { headers: { Authorization: `Bearer ${deck.token}` } });
  assert.equal(rejected.status, 401, 'La révocation du Stream Deck s’applique aux commandes et états');
  const rejectedHls = await fetch(`${baseUrl}${preview.url}`);
  assert.equal(rejectedHls.status, 401, 'La révocation invalide aussi une session HLS déjà émise');
  steps.push('Retour vidéo : HLS proxifié avec session authentifiée ; Stream Deck révocable');
  console.log(JSON.stringify({ passed: true, steps, pageErrors, failedApi, screenshots: ['gabin-studio-pc.png', 'gabin-studio-ipad.png',
    'nino-auto-settings-pc.png', 'nino-auto-pc.png', 'nino-auto-ipad.png', 'nino-auto-ipad-portrait.png', 'nino-auto-pc-detail.png', 'nino-auto-ipad-detail.png',
    'nino-resolve-pc.png', 'nino-resolve-ipad.png'].map(name => join(screenshotDir, name)) }, null, 2));
} catch (error) {
  await mkdir(screenshotDir, { recursive: true });
  if (pc) await captureProof(pc, join(screenshotDir, 'gabin-studio-failure-pc.png'), browserEngine === 'webkit').catch(() => undefined);
  if (ipad) await captureProof(ipad, join(screenshotDir, 'gabin-studio-failure-ipad.png'), browserEngine === 'webkit').catch(() => undefined);
  const videoStates = await Promise.all([pc, ipad].map(page => page?.locator('video').evaluateAll((videos: HTMLVideoElement[]) => videos.map(video => ({
    readyState: video.readyState, width: video.videoWidth, height: video.videoHeight, time: video.currentTime,
    paused: video.paused, muted: video.muted, error: video.error?.code ?? null,
    quality: typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null,
  }))).catch(() => undefined)));
  console.error(JSON.stringify({ passed: false, steps, pageErrors, failedApi, videoStates, error: error instanceof Error ? error.stack : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (meterTimer) clearInterval(meterTimer);
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
