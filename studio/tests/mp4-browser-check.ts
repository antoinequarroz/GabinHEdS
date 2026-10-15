import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/api/src/app.js';
import { emptyMediaState, type MediaGateway } from '../apps/api/src/media.js';
import { startFakeObs } from './fake-obs.js';
import { createMediaFixture } from './media-fixture.js';
import { noOverflow, proofScreenshot } from './browser-rendering.js';
import type { AuthResult, PairingCode, Project, StudioState } from '@gabin/shared';

// Isolated API + compiled web UI + OBS protocol fixture. No physical capture,
// live Nino server, production files, microphone or camera are accessed.
const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const bundledModules = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
let playwright: any;
let usesBundledRuntime = false;
if (process.env.GABIN_PLAYWRIGHT_MODULE) playwright = require(process.env.GABIN_PLAYWRIGHT_MODULE);
else {
  try { playwright = require('playwright'); }
  catch (error) {
    if (process.platform !== 'darwin' || !existsSync(bundledModules)) throw new Error('Playwright manque pour la recette isolée MP4.', { cause: error });
    playwright = require(bundledModules); usesBundledRuntime = true;
  }
}
const engine = process.env.GABIN_TEST_BROWSER ?? 'chromium';
assert(['chromium', 'webkit'].includes(engine), 'GABIN_TEST_BROWSER doit être chromium ou webkit');
const bundledChromium = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const channel = process.env.GABIN_CHROMIUM_CHANNEL;
assert(!channel || ['chromium', 'chrome', 'msedge'].includes(channel), 'Canal Chromium non reconnu');
const executablePath = process.env.GABIN_CHROMIUM_PATH ?? (usesBundledRuntime && !channel && existsSync(bundledChromium) ? bundledChromium : undefined);
const temp = await mkdtemp(join(tmpdir(), 'nino-mp4-browser-'));
const screenshotDir = process.env.GABIN_SCREENSHOT_DIR ?? join(tmpdir(), `nino-mp4-proof-${engine}`);
const dormantMedia: MediaGateway = {
  getState: emptyMediaState, refresh: async () => emptyMediaState(),
  ingestSettings: () => ({ server: 'rtmp://127.0.0.1:9/gabin', key: 'fixture' }),
  startLive: async () => { throw new Error('Aucun live dans cette recette MP4'); }, stopLive: async () => undefined,
  hlsResource: async () => new Response('', { status: 404 }), subscribe: () => () => undefined, close: async () => undefined,
};
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let fixture: Awaited<ReturnType<typeof startFakeObs>> | undefined;
let browser: any;
let pc: any;
let baseUrl = '';
let token = '';
const pageErrors: string[] = [];
const steps: string[] = [];

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api${path}`, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response.json() as Promise<T>;
}
async function openTakes(page: any, projectId: string): Promise<void> {
  await page.goto(`${baseUrl}/#project/${projectId}`);
  await page.getByRole('button', { name: /Retrouver les prises/ }).click();
  await page.getByRole('heading', { name: 'Les prises de cette production', exact: true }).waitFor();
}
async function controlsFit(page: any, label: string): Promise<void> {
  await noOverflow(page, label);
  const sizes = await page.locator('.takes-delivery button').evaluateAll((buttons: HTMLButtonElement[]) => buttons.map(button => {
    const rect = button.getBoundingClientRect();
    return { text: button.textContent?.trim(), width: rect.width, height: rect.height };
  }));
  assert(sizes.length >= 4 && sizes.every((size: any) => size.width >= 44 && size.height >= 44), `${label}: commandes tactiles de 44 px minimum ${JSON.stringify(sizes)}`);
  const clipped = await page.locator('.takes-heading-actions > .button').evaluateAll((buttons: HTMLButtonElement[]) => {
    const problems: string[] = [];
    for (const button of buttons) {
      const bounds = button.getBoundingClientRect();
      const contents = [...button.querySelectorAll('svg')].map(icon => icon.getBoundingClientRect());
      for (const node of button.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        contents.push(...range.getClientRects());
      }
      if (contents.some(rect => rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1))) problems.push(button.textContent?.trim() ?? '');
    }
    return problems;
  });
  assert.deepEqual(clipped, [], `${label}: texte et icônes contenus dans leurs boutons de récupération`);
}
async function capture(page: any, name: string): Promise<void> {
  await page.locator('.toast').waitFor({ state: 'hidden', timeout: 10_000 });
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await proofScreenshot(page, join(screenshotDir, name), engine === 'webkit' || page.viewportSize().width <= 1024);
}

try {
  const encoded = await createMediaFixture(join(temp, 'encoded'));
  fixture = await startFakeObs({ recordingFixture: encoded.mkv, meters: false });
  app = await buildApp({ dataDir: join(temp, 'data'), media: dormantMedia });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert(address && typeof address !== 'string');
  assert.notEqual(address.port, 4310, 'La recette utilise uniquement son serveur temporaire');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const auth = await api<AuthResult>('/auth/local', 'POST'); token = auth.token;
  await api('/room', 'PATCH', { obsUrl: fixture.url, recordingRoot: join(temp, 'recordings') });
  await api('/obs/connect', 'POST');
  const project = await api<Project>('/projects', 'POST', { title: 'Séance MP4 · Léa', format: 'podcast',
    participants: [{ id: 'lea', name: 'Léa', micInput: 'Micro 1', sceneName: 'Podcast' }] });
  for (let index = 0; index < 2; index++) {
    await api('/control', 'POST', { action: 'record.start', projectId: project.id, requestId: crypto.randomUUID() });
    await api('/control', 'POST', { action: 'record.stop', requestId: crypto.randomUUID() });
  }
  const state = await api<StudioState>('/state');
  const take = state.takes.find(item => item.sequence === 1)!;
  const otherTake = state.takes.find(item => item.sequence === 2)!;
  assert(take?.status === 'completed' && take.outputPath && otherTake?.status === 'completed');
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === 'chromium' ? { ...(executablePath ? { executablePath } : channel ? { channel } : {}) } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.addInitScript((deviceToken: string) => localStorage.setItem('gabin.studio.device', deviceToken), token);
  pc = await context.newPage(); pc.setDefaultTimeout(15_000);
  pc.on('pageerror', (error: Error) => pageErrors.push(error.message));
  await openTakes(pc, project.id);
  const row = pc.locator('.takes-row').filter({ has: pc.getByRole('heading', { name: take.title, exact: true }) });
  const otherRow = pc.locator('.takes-row').filter({ has: pc.getByRole('heading', { name: otherTake.title, exact: true }) });
  const mp4 = row.getByRole('button', { name: 'Télécharger en MP4', exact: true });
  let downloads = 0; pc.on('download', () => downloads++);
  const pendingDownload = pc.waitForEvent('download', { timeout: 45_000 });
  await mp4.click();
  const download = await pendingDownload;
  assert.equal(await download.failure(), null);
  assert.equal(download.suggestedFilename().normalize('NFC'), `${take.title}.mp4`.normalize('NFC'), 'Nom UTF8 canonique de la prise et extension MP4');
  const saved = join(temp, 'download.mp4'); await download.saveAs(saved);
  assert((await readFile(saved)).subarray(0, 32).includes(Buffer.from('ftyp')), 'Le téléchargement est un MP4, pas une archive');
  const ffprobe = process.env.GABIN_FFPROBE_PATH ?? (existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');
  const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', saved], { timeout: 15_000 });
  const probe = JSON.parse(stdout);
  assert(probe.streams.some((stream: any) => stream.codec_type === 'video' && stream.codec_name === 'h264' && stream.width === 640 && stream.height === 360));
  assert(probe.streams.some((stream: any) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
  assert(Math.abs(Number(probe.format.duration) - 4) < .15, 'Toute la durée vidéo/audio est conservée');
  const ffmpeg = process.env.GABIN_FFMPEG_PATH ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
  await execute(ffmpeg, ['-v', 'error', '-nostdin', '-i', saved, '-f', 'null', '-'], { timeout: 15_000 });
  assert.deepEqual(await readFile(take.outputPath), await readFile(encoded.mkv), 'Original OBS inchangé');
  await pc.getByText('Le téléchargement du MP4 a été lancé. Consultez les téléchargements de votre navigateur ; l’original est conservé.', { exact: true }).waitFor();
  steps.push('MP4 réel : prise ciblée, nom UTF8, sans ZIP, 4 s H.264 640×360 + AAC entièrement décodables, original identique');

  const endpoint = `${baseUrl}/api/takes/${take.id}/mp4-download-ticket`;
  let polls = 0;
  await pc.route(endpoint, (route: any) => { polls++; return route.fulfill({ status: 202, json: { status: 'preparing' } }); });
  await mp4.click();
  const preparing = row.getByRole('button', { name: 'Préparation du MP4…', exact: true });
  await preparing.waitFor(); assert(await preparing.isDisabled());
  assert(await otherRow.getByRole('button', { name: 'Télécharger en MP4', exact: true }).isEnabled(), 'La préparation est propre à la prise');
  assert(await row.getByRole('button', { name: 'Télécharger le fichier', exact: true }).isEnabled(), 'L’original reste disponible');
  await controlsFit(pc, 'PC pendant préparation');
  await row.getByRole('button', { name: `Annuler l’attente du MP4 de ${take.title}`, exact: true }).click();
  await mp4.waitFor(); assert(await mp4.isEnabled());
  await pc.getByText('Attente du MP4 interrompue. Le PC peut continuer la préparation ; relancez le téléchargement quand vous le souhaitez.', { exact: true }).waitFor();
  await pc.waitForTimeout(1800);
  assert.equal(polls, 1, 'Annuler libère le délai et empêche les sondages suivants');
  assert.equal(downloads, 1, 'Aucun fichier lancé après annulation');
  await pc.unroute(endpoint);
  steps.push('Préparation par prise : bouton occupé, original et autre prise disponibles ; annulation sans sondage ni téléchargement tardif');

  // Only negative replies are injected. The successful file above and its
  // audio/video were produced and downloaded through the real API worker.
  const failures = [
    { reply: { status: 'failed', error: 'Conversion fixture refusée.' }, error: 'Conversion fixture refusée.' },
    { reply: { status: 'ready' }, error: 'Le studio n’a pas transmis le fichier MP4 préparé.' },
    { reply: { status: 'unknown' }, error: 'Le studio a transmis un état de préparation MP4 invalide.' },
    ...[
      `https://external.invalid/api/mp4-downloads/${'A'.repeat(43)}`,
      `/api/mp4-downloads/${'A'.repeat(43)}?extra=1`,
      `/api/mp4-downloads/${'A'.repeat(43)}#extra`,
      `${baseUrl.replace('://', '://unexpected:password@')}/api/mp4-downloads/${'A'.repeat(43)}`,
    ].map(url => ({ reply: { status: 'ready', ticket: { url, expiresAt: new Date(Date.now() + 60_000).toISOString() } }, error: 'Le lien transmis par le studio est invalide.' })),
  ];
  let externalRequests = 0;
  await pc.route('https://external.invalid/**', (route: any) => { externalRequests++; return route.abort(); });
  for (const failure of failures) {
    await pc.route(endpoint, (route: any) => route.fulfill({ status: 200, json: failure.reply }));
    await mp4.click(); await pc.getByText(failure.error, { exact: true }).waitFor();
    assert(await mp4.isEnabled(), 'Une erreur libère le bouton pour réessayer');
    await pc.unroute(endpoint);
  }
  assert.equal(externalRequests, 0, 'Aucun ticket hors origine n’est suivi');
  await pc.route(endpoint, (route: any) => route.fulfill({ status: 500, json: { error: 'Erreur serveur fixture.' } }));
  await mp4.click(); await pc.getByText('Erreur serveur fixture.', { exact: true }).waitFor(); await pc.unroute(endpoint);

  const missingUrl = `/api/mp4-downloads/${'B'.repeat(43)}`;
  let missingGets = 0;
  await pc.route(endpoint, (route: any) => route.fulfill({ status: 200, json: { status: 'ready', ticket: { url: missingUrl, expiresAt: new Date(Date.now() + 60_000).toISOString() } } }));
  await pc.route(`${baseUrl}${missingUrl}`, (route: any) => { if (route.request().method() === 'GET') missingGets++; return route.fulfill({ status: 410 }); });
  await mp4.click();
  await pc.getByText('Le fichier MP4 n’est plus disponible ou le lien a expiré. Réessayez depuis cette prise.', { exact: true }).waitFor();
  assert.equal(missingGets, 0, 'Un HEAD refusé ne lance pas le fichier');
  assert.equal(downloads, 1, 'Les erreurs ne déclenchent aucun téléchargement');
  await pc.unroute(`${baseUrl}${missingUrl}`);
  for (const headers of [{ 'content-type': 'text/html', 'content-disposition': 'attachment; filename="wrong.mp4"' }, { 'content-type': 'video/mp4' }]) {
    await pc.route(`${baseUrl}${missingUrl}`, (route: any) => route.fulfill({ status: 200, headers }));
    await mp4.click();
    await pc.getByText('Le studio n’a pas confirmé un fichier MP4 téléchargeable. Réessayez depuis cette prise.', { exact: true }).waitFor();
    await pc.unroute(`${baseUrl}${missingUrl}`);
  }
  await pc.unroute(endpoint);
  assert.equal(downloads, 1, 'Les en-têtes incorrects ne déclenchent aucun téléchargement');
  steps.push('Échecs : conversion, HTTP, ticket absent/invalide/hors origine/avec identifiants, HEAD expiré ou mauvais type/disposition ; aucun succès ni fichier inventé');

  polls = 0;
  await pc.route(endpoint, (route: any) => { polls++; return route.fulfill({ status: 202, json: { status: 'preparing' } }); });
  await mp4.click(); await preparing.waitFor();
  await pc.locator('.sidebar').getByRole('button', { name: 'Productions', exact: true }).click();
  await pc.getByRole('heading', { name: 'Vos productions', exact: true }).waitFor();
  await pc.waitForTimeout(1800); assert.equal(polls, 1, 'Quitter la production arrête aussi son attente');
  await pc.unroute(endpoint); await openTakes(pc, project.id);
  steps.push('Navigation : quitter le projet annule l’attente sans fichier lancé tardivement');

  await mkdir(screenshotDir, { recursive: true });
  await controlsFit(pc, 'PC 1440');
  await capture(pc, 'mp4-pc.png');
  const pairing = await api<PairingCode>('/pairing', 'POST', { role: 'viewer', kind: 'ipad' });
  const viewer = await api<AuthResult>('/auth/pair', 'POST', { code: pairing.code, name: 'iPad consultation fixture', kind: 'ipad' });
  const tabletContext = await browser.newContext({ viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  await tabletContext.addInitScript((deviceToken: string) => localStorage.setItem('gabin.studio.device', deviceToken), viewer.token);
  const ipad = await tabletContext.newPage(); ipad.setDefaultTimeout(15_000);
  ipad.on('pageerror', (error: Error) => pageErrors.push(error.message));
  await openTakes(ipad, project.id); await controlsFit(ipad, 'iPad 1024 consultation');
  const tabletDownload = ipad.waitForEvent('download', { timeout: 30_000 });
  await ipad.locator('.takes-row').filter({ has: ipad.getByRole('heading', { name: take.title, exact: true }) }).getByRole('button', { name: 'Télécharger en MP4', exact: true }).click();
  const viewedCopy = await tabletDownload; assert.equal(await viewedCopy.failure(), null);
  assert.equal(viewedCopy.suggestedFilename().normalize('NFC'), `${take.title}.mp4`.normalize('NFC'), 'Téléchargement autorisé en consultation sur iPad');
  await capture(ipad, 'mp4-ipad.png');
  await ipad.setViewportSize({ width: 768, height: 1024 }); await controlsFit(ipad, 'iPad portrait 768');
  await capture(ipad, 'mp4-ipad-portrait.png');
  await ipad.setViewportSize({ width: 390, height: 844 }); await controlsFit(ipad, 'Mobile 390');
  await capture(ipad, 'mp4-mobile.png');
  steps.push('PC/iPad/petit écran : aucun débordement, cibles 44 px, MP4 réel autorisé en consultation');
  assert.deepEqual(pageErrors, [], 'Aucune exception JavaScript');
  console.log(JSON.stringify({ passed: true, engine, steps, screenshotDir }, null, 2));
} catch (error) {
  await mkdir(screenshotDir, { recursive: true });
  if (pc) await proofScreenshot(pc, join(screenshotDir, 'mp4-failure.png'), engine === 'webkit').catch(() => undefined);
  console.error(JSON.stringify({ passed: false, engine, steps, pageErrors, error: error instanceof Error ? error.stack : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  const closed = await Promise.allSettled([browser?.close(), app?.close(), fixture?.close()]);
  for (const result of closed) if (result.status === 'rejected') {
    console.error('Nettoyage de la recette MP4 incomplet :', result.reason instanceof Error ? result.reason.message : String(result.reason));
    process.exitCode = 1;
  }
  await rm(temp, { recursive: true, force: true });
}
