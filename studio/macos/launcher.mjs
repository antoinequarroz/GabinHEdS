// Nino launcher for macOS. Runs with the Node.js runtime bundled in Nino.app.
// It never starts a recording or a live stream. --stop asks the API to prove
// the room is idle before closing the services it owns; OBS stays open.
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, closeSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const API_PORTS = [4310, 4312];
const MEDIA_PORTS = [9997, 8554, 1935, 8888];

export class LauncherError extends Error {}
const fail = message => { throw new LauncherError(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function parseArguments(argv) {
  const known = new Set(['--stop', '--no-browser', '--no-obs', '--no-dialogs']);
  for (const argument of argv) if (!known.has(argument) && !argument.startsWith('-psn_')) fail(`Option inconnue : ${argument}`);
  const timeout = Number(process.env.NINO_STARTUP_TIMEOUT_SECONDS ?? 90);
  if (!Number.isInteger(timeout) || timeout < 5 || timeout > 300) fail('NINO_STARTUP_TIMEOUT_SECONDS doit être compris entre 5 et 300.');
  return { stop: argv.includes('--stop'), noBrowser: argv.includes('--no-browser'), noObs: argv.includes('--no-obs'),
    noDialogs: argv.includes('--no-dialogs'), timeoutSeconds: timeout };
}

export function getLayout(resources, lock, home = os.homedir(), override = process.env.NINO_USER_ROOT) {
  const userRoot = override || join(home, 'Library/Application Support/Nino');
  if (!isAbsolute(userRoot)) fail('NINO_USER_ROOT doit être un chemin absolu.');
  const mediaVersion = lock.mediamtx?.version ?? 'unknown';
  const ffmpegVersion = lock.ffmpeg?.version ?? 'unknown';
  return {
    resources, lock, userRoot,
    appRoot: join(resources, 'app'),
    dataRoot: join(userRoot, 'data'),
    logRoot: join(userRoot, 'logs'),
    runRoot: join(userRoot, 'run'),
    settingsPath: join(userRoot, 'settings.json'),
    tokenPath: join(userRoot, 'run/shutdown-token.txt'),
    lockPath: join(userRoot, 'run/launcher.lock'),
    nodePath: join(resources, 'runtime/node/bin/node'),
    entryPath: join(resources, 'app/apps/api/dist/index.mjs'),
    webPath: join(resources, 'app/apps/web/dist/index.html'),
    bundledMediaPath: join(resources, 'runtime/mediamtx/mediamtx'),
    bundledMediaConfigPath: join(resources, 'app/config/mediamtx.yml'),
    // Copied out of the (possibly quarantined, possibly translocated) bundle so
    // the media relay always runs from a stable path the launcher can recognise.
    mediaRoot: join(userRoot, 'runtime/mediamtx', mediaVersion),
    mediaPath: join(userRoot, 'runtime/mediamtx', mediaVersion, 'mediamtx'),
    mediaConfigPath: join(userRoot, 'runtime/mediamtx', mediaVersion, 'mediamtx.yml'),
    ffmpegRoot: join(userRoot, 'runtime/ffmpeg', ffmpegVersion),
    ffmpegPath: join(userRoot, 'runtime/ffmpeg', ffmpegVersion, 'ffmpeg'),
    ffprobePath: join(userRoot, 'runtime/ffmpeg', ffmpegVersion, 'ffprobe'),
  };
}

// ---------------------------------------------------------------- macOS UI
function osascript(lines, argv = []) {
  return spawnSync('/usr/bin/osascript', [...lines.flatMap(line => ['-e', line]), '--', ...argv], { encoding: 'utf8', timeout: 600_000 });
}
function showMessage(message, { error = false, dialogs = true } = {}) {
  (error ? console.error : console.log)(message);
  if (!dialogs) return;
  osascript(['on run argv', `display alert "Nino" message (item 1 of argv)${error ? ' as critical' : ''} buttons {"OK"} default button "OK"`, 'end run'], [message]);
}
function notify(message, dialogs) {
  console.log(message);
  if (dialogs) osascript(['on run argv', 'display notification (item 1 of argv) with title "Nino"', 'end run'], [message]);
}
function choose(message, buttons, fallback) {
  const result = osascript(['on run argv',
    `set answer to display dialog (item 1 of argv) with title "Nino" buttons {${buttons.map(b => JSON.stringify(b)).join(', ')}} default button ${JSON.stringify(fallback)} with icon note`,
    'return button returned of answer', 'end run'], [message]);
  return result.status === 0 ? result.stdout.trim() : null;
}

// ------------------------------------------------------------ settings/token
export function parseSettings(source, path) {
  const settings = { listenOnLan: false, obsPath: null };
  if (source === undefined) return settings;
  let saved;
  try { saved = JSON.parse(source); } catch { fail(`Le fichier de configuration est invalide : ${path}`); }
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) fail(`La configuration doit contenir un objet JSON : ${path}`);
  for (const key of Object.keys(saved)) if (!['listenOnLan', 'obsPath'].includes(key)) fail(`Réglage Nino inconnu : ${key}`);
  if ('listenOnLan' in saved) {
    if (typeof saved.listenOnLan !== 'boolean') fail('listenOnLan doit être un booléen JSON (true ou false).');
    settings.listenOnLan = saved.listenOnLan;
  }
  if (saved.obsPath !== undefined && saved.obsPath !== null) {
    if (typeof saved.obsPath !== 'string' || !isAbsolute(saved.obsPath) || !/\.app\/?$/.test(saved.obsPath)) {
      fail('obsPath doit être le chemin complet vers OBS.app, par exemple /Applications/OBS.app.');
    }
    settings.obsPath = saved.obsPath;
  }
  return settings;
}
async function readSettings(path) {
  let source;
  try { source = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return parseSettings(source, path);
}
async function getShutdownToken(path, create) {
  try {
    const token = (await readFile(path, 'ascii')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail('Le jeton local du lanceur est invalide. Consultez le support avant de relancer.');
    return token;
  } catch (error) {
    if (error instanceof LauncherError) throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  if (!create) fail('Le jeton local du lanceur est absent. Aucun service ne sera arrêté.');
  const token = randomBytes(32).toString('base64url');
  await writeFile(path, token, { encoding: 'ascii', mode: 0o600 });
  return token;
}

// ------------------------------------------------------------------ locking
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
async function acquireLock(path) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => { await rm(path, { force: true }); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number((await readFile(path, 'utf8').catch(() => '')).trim());
      if (!Number.isInteger(holder) || holder <= 0 || !alive(holder)) { await rm(path, { force: true }); continue; }
      if (Date.now() > deadline) fail('Un démarrage Nino est déjà en cours. Patientez puis relancez Nino.');
      await sleep(250);
    }
  }
}

// --------------------------------------------------------- process identity
function processInfo(pid) {
  const start = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  const command = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (start.status !== 0 || command.status !== 0) return null;
  return { startedAt: start.stdout.trim(), command: command.stdout.trim() };
}
export function matchesRecord(record, info, anchor) {
  return Boolean(record && info && Number.isInteger(record.pid) && record.pid > 0
    && record.anchor === anchor && typeof record.startedAt === 'string' && record.startedAt === info.startedAt
    && info.command.includes(anchor));
}
async function ownedProcess(statePath, anchor) {
  let record;
  try { record = JSON.parse(await readFile(statePath, 'utf8')); } catch { return null; }
  if (!record || !Number.isInteger(record.pid) || !alive(record.pid)) return null;
  return matchesRecord(record, processInfo(record.pid), anchor) ? record.pid : null;
}

// -------------------------------------------------------------------- ports
export function parseLsof(output) {
  const owners = [];
  let pid = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1));
      if (Number.isInteger(port)) owners.push({ pid, port });
    }
  }
  return owners;
}
function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
async function portOwners(ports) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', timeout: 20_000 });
  // lsof exits 1 when nothing matches. Anything else is not proof of a free port.
  if (result.error || (result.status !== 0 && !(result.status === 1 && !result.stdout.trim()))) {
    fail('Impossible de vérifier les ports réseau de ce Mac. Aucun programme n’a été arrêté.');
  }
  const owners = parseLsof(result.stdout).filter(owner => ports.includes(owner.port));
  // Another account's listener can be invisible to lsof: a TCP answer still means "occupied".
  for (const port of ports) if (!owners.some(owner => owner.port === port) && await canConnect(port)) owners.push({ pid: 0, port });
  return owners.filter((owner, index) => owners.findIndex(other => other.pid === owner.pid && other.port === owner.port) === index);
}
const describe = owners => owners.map(owner => `${owner.port} (${owner.pid ? `PID ${owner.pid}` : 'autre compte'})`).join(', ');
async function assertPortsAvailable(ports, service) {
  const occupied = await portOwners(ports);
  if (occupied.length) fail(`${service} ne peut pas démarrer : port déjà utilisé (${describe(occupied)}). Aucun programme n’a été arrêté. Fermez l’autre instance si elle n’enregistre pas, puis relancez Nino.`);
}

// ------------------------------------------------------------------- health
async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  return { status: response.status, body: await response.json() };
}
async function healthy(service) {
  try {
    if (service === 'media') {
      const { status, body } = await getJson('http://127.0.0.1:9997/v3/paths/list');
      return status === 200 && body && 'items' in body && 'itemCount' in body;
    }
    const studio = await getJson('http://127.0.0.1:4310/api/guest/config');
    const guest = await getJson('http://127.0.0.1:4312/api/guest/config');
    return studio.status === 200 && studio.body.mode === 'studio' && guest.status === 200 && guest.body.mode === 'guest';
  } catch { return false; }
}
async function waitService(service, pid, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  do {
    if (!alive(pid)) fail(`${service} s’est arrêté pendant le démarrage. Consultez les journaux Nino.`);
    if (await healthy(service)) return;
    await sleep(400);
  } while (Date.now() < deadline);
  fail(`${service} ne répond pas après ${timeoutSeconds} secondes. Aucun processus n’a été arrêté. Consultez les journaux Nino avant de relancer.`);
}
async function startService({ service, layout, executable, args, anchor, ports, env, timeoutSeconds }) {
  const statePath = join(layout.runRoot, `${service}.json`);
  const existing = await ownedProcess(statePath, anchor);
  if (existing) {
    const foreign = (await portOwners(ports)).filter(owner => owner.pid !== existing);
    if (foreign.length) fail(`Un autre programme utilise un port de ${service}. Aucun processus n’a été arrêté.`);
    console.log(`Nino : réutilisation de ${service} (PID ${existing}).`);
    await waitService(service, existing, timeoutSeconds);
    return existing;
  }
  await assertPortsAvailable(ports, service);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stdout = openSync(join(layout.logRoot, `${service}-${stamp}.log`), 'a', 0o600);
  const stderr = openSync(join(layout.logRoot, `${service}-${stamp}.error.log`), 'a', 0o600);
  let child;
  try {
    child = spawn(executable, args, { cwd: layout.appRoot, env, detached: true, stdio: ['ignore', stdout, stderr] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } finally { closeSync(stdout); closeSync(stderr); }
  child.unref();
  const info = processInfo(child.pid);
  if (!info) fail(`${service} s’est arrêté pendant le démarrage. Consultez les journaux Nino.`);
  const temporary = `${statePath}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify({ pid: child.pid, startedAt: info.startedAt, executablePath: executable, anchor }, null, 2), { mode: 0o600 });
  await rename(temporary, statePath);
  console.log(`Nino : démarrage de ${service}...`);
  await waitService(service, child.pid, timeoutSeconds);
  const foreign = (await portOwners(ports)).filter(owner => owner.pid !== child.pid);
  if (foreign.length) fail(`Un autre programme utilise un port de ${service}. Consultez les journaux avant de relancer.`);
  return child.pid;
}

// ------------------------------------------------------------------ runtimes
async function installMediaRelay(layout) {
  const binary = await readFile(layout.bundledMediaPath);
  const config = await readFile(layout.bundledMediaConfigPath);
  const current = await Promise.all([readFile(layout.mediaPath).catch(() => null), readFile(layout.mediaConfigPath).catch(() => null)]);
  if (current[0] && current[1] && sha256(current[0]) === sha256(binary) && sha256(current[1]) === sha256(config)) return;
  await mkdir(layout.mediaRoot, { recursive: true });
  // Plain byte copies: no quarantine attribute is carried over from the download.
  for (const [target, bytes, mode] of [[layout.mediaPath, binary, 0o755], [layout.mediaConfigPath, config, 0o644]]) {
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, bytes, { mode });
    await rename(temporary, target);
  }
}
async function downloadVerified(spec, label) {
  const url = new URL(spec.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.hash || !/^[a-f0-9]{64}$/.test(spec.sha256)) {
    fail('Le manifeste de téléchargement Nino est invalide.');
  }
  console.log(`Téléchargement vérifié : ${spec.url}`);
  let response;
  try { response = await fetch(spec.url, { signal: AbortSignal.timeout(300_000) }); }
  catch { fail(`Téléchargement de ${label} impossible. Vérifiez la connexion Internet puis relancez Nino.`); }
  if (!response.ok) fail(`Téléchargement de ${label} refusé (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== spec.sha256) fail('Empreinte du téléchargement incorrecte : aucun exécutable ne sera utilisé.');
  return gunzipSync(bytes);
}
async function prepareFfmpeg(layout, dialogs) {
  const spec = layout.lock.ffmpeg;
  const receiptPath = join(layout.ffmpegRoot, 'nino-runtime.json');
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt.ffmpegArchiveSha256 === spec.ffmpeg.sha256 && receipt.ffprobeArchiveSha256 === spec.ffprobe.sha256
      && receipt.ffmpegSha256 === sha256(await readFile(layout.ffmpegPath))
      && receipt.ffprobeSha256 === sha256(await readFile(layout.ffprobePath))) return;
  } catch { /* missing or incomplete: prepare again */ }
  notify('Préparation des outils vidéo (une seule fois, connexion Internet nécessaire)…', dialogs);
  const stage = join(dirname(layout.ffmpegRoot), `.prepare-${randomBytes(6).toString('hex')}`);
  try {
    await mkdir(stage, { recursive: true });
    const ffmpeg = await downloadVerified(spec.ffmpeg, 'FFmpeg');
    const ffprobe = await downloadVerified(spec.ffprobe, 'ffprobe');
    await writeFile(join(stage, 'ffmpeg'), ffmpeg, { mode: 0o755 });
    await writeFile(join(stage, 'ffprobe'), ffprobe, { mode: 0o755 });
    const encoders = spawnSync(join(stage, 'ffmpeg'), ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 60_000 });
    if (encoders.status !== 0 || !/libx264/.test(encoders.stdout + encoders.stderr) || !/\baac\b/.test(encoders.stdout + encoders.stderr)) {
      fail('FFmpeg ne fournit pas les encodeurs H.264 et AAC requis.');
    }
    const probe = spawnSync(join(stage, 'ffprobe'), ['-version'], { encoding: 'utf8', timeout: 60_000 });
    if (probe.status !== 0 || !/ffprobe version/.test(probe.stdout)) fail('ffprobe ne démarre pas correctement.');
    await writeFile(join(stage, 'nino-runtime.json'), JSON.stringify({
      version: spec.version, source: spec.source,
      ffmpegArchiveSha256: spec.ffmpeg.sha256, ffprobeArchiveSha256: spec.ffprobe.sha256,
      ffmpegSha256: sha256(ffmpeg), ffprobeSha256: sha256(ffprobe),
    }, null, 2));
    if (existsSync(layout.ffmpegRoot)) await rename(layout.ffmpegRoot, `${layout.ffmpegRoot}.previous-${randomBytes(6).toString('hex')}`);
    await rename(stage, layout.ffmpegRoot);
    console.log(`FFmpeg ${spec.version} et ffprobe sont prêts.`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------- stop
async function mediaIdle() {
  try {
    const { status, body } = await getJson('http://127.0.0.1:9997/v3/paths/list');
    if (status !== 200 || !Array.isArray(body.items) || body.itemCount !== body.items.length) return false;
    return body.items.every(item => item.ready === false && item.source === null);
  } catch { return false; }
}
async function waitExit(pid, ms) {
  const deadline = Date.now() + ms;
  while (alive(pid)) { if (Date.now() > deadline) return false; await sleep(200); }
  return true;
}
async function stopServices(layout) {
  const apiState = join(layout.runRoot, 'api.json');
  const mediaState = join(layout.runRoot, 'media.json');
  const api = await ownedProcess(apiState, layout.apiAnchor);
  if (api) {
    if ((await portOwners(API_PORTS)).some(owner => owner.pid !== api)) fail('Un autre programme utilise un port Nino. Aucun service ne sera arrêté.');
    const token = await getShutdownToken(layout.tokenPath, false);
    let accepted = false;
    try {
      const response = await fetch('http://127.0.0.1:4310/api/local-shutdown', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000),
      });
      accepted = response.status === 202 && (await response.json()).accepted === true;
    } catch { accepted = false; }
    if (!accepted) fail('Nino ne peut pas confirmer un arrêt sans danger. Terminez les enregistrements et le live, connectez OBS dans Nino puis réessayez. Aucun processus n’a été forcé à quitter.');
    if (!await waitExit(api, 20_000)) fail('Nino a accepté l’arrêt mais son serveur ne s’est pas fermé. OBS et le relais vidéo restent ouverts ; consultez les journaux.');
    await rm(apiState, { force: true });
  } else {
    // Missing or stale metadata never authorises stopping a listener by name.
    await assertPortsAvailable(API_PORTS, 'Nino');
  }
  const media = await ownedProcess(mediaState, layout.mediaConfigPath);
  if (media) {
    if ((await portOwners(MEDIA_PORTS)).some(owner => owner.pid !== media) || !await mediaIdle()) {
      fail('Le relais vidéo est actif ou son état est incertain. Il reste ouvert. Arrêtez la diffusion dans OBS avant de réessayer.');
    }
    process.kill(media, 'SIGTERM');
    if (!await waitExit(media, 10_000)) fail('Le relais vidéo ne s’est pas fermé. Consultez les journaux Nino.');
    await rm(mediaState, { force: true });
  }
  console.log('Les services Nino sont arrêtés. OBS reste ouvert. Vous pouvez maintenant mettre Nino à jour.');
}

// ---------------------------------------------------------------------- OBS
function obsRunning() {
  return spawnSync('/usr/bin/pgrep', ['-x', 'OBS'], { encoding: 'utf8' }).status === 0;
}
function findObs(configured) {
  if (configured) {
    if (!existsSync(configured)) fail(`OBS est introuvable au chemin configuré : ${configured}`);
    return configured;
  }
  return ['/Applications/OBS.app', join(os.homedir(), 'Applications/OBS.app')].find(candidate => existsSync(candidate)) ?? null;
}

// --------------------------------------------------------------------- main
export async function runLauncher(resources, argv) {
  let options = { noDialogs: true };
  let layout = null;
  let release = null;
  try {
    options = parseArguments(argv);
    if (process.platform !== 'darwin') fail('Ce lanceur est destiné à macOS.');
    layout = getLayout(resources, JSON.parse(await readFile(join(resources, 'macos/runtime-lock.json'), 'utf8')));
    for (const directory of [layout.dataRoot, layout.logRoot, layout.runRoot]) await mkdir(directory, { recursive: true, mode: 0o700 });
    // A stable per-account marker, so a moved or translocated Nino.app still recognises its own server.
    layout.apiAnchor = `--nino-owner=${sha256(layout.userRoot).slice(0, 20)}`;
    release = await acquireLock(layout.lockPath);
    if (options.stop) {
      await stopServices(layout);
      if (!options.noDialogs) showMessage('Nino est arrêté. OBS reste ouvert.');
      return 0;
    }
    const dialogs = !options.noDialogs;
    const runningApi = await ownedProcess(join(layout.runRoot, 'api.json'), layout.apiAnchor);
    if (runningApi && dialogs && await healthy('api')) {
      const answer = choose('Nino est déjà ouvert sur ce Mac.', ['Arrêter Nino', 'Ouvrir Nino'], 'Ouvrir Nino');
      if (answer === 'Arrêter Nino') {
        await stopServices(layout);
        showMessage('Nino est arrêté. OBS reste ouvert.');
        return 0;
      }
      if (answer === null) return 0;
    }
    for (const file of [layout.nodePath, layout.entryPath, layout.webPath, layout.bundledMediaPath, layout.bundledMediaConfigPath]) {
      if (!existsSync(file)) fail(`Installation Nino incomplète : ${file}. Téléchargez à nouveau Nino ; vos données ne seront pas supprimées.`);
    }
    await installMediaRelay(layout);
    await prepareFfmpeg(layout, dialogs);
    const settings = await readSettings(layout.settingsPath);
    const env = {
      ...process.env,
      NINO_DATA_DIR: layout.dataRoot,
      NINO_HOST: settings.listenOnLan ? '0.0.0.0' : '127.0.0.1',
      NINO_PORT: '4310',
      NINO_GUEST_HOST: '127.0.0.1',
      NINO_GUEST_PORT: '4312',
      NINO_FFMPEG_PATH: layout.ffmpegPath,
      NINO_FFPROBE_PATH: layout.ffprobePath,
      NINO_LOCAL_SHUTDOWN_TOKEN: await getShutdownToken(layout.tokenPath, true),
      NINO_MEDIA_API_URL: 'http://127.0.0.1:9997',
      NINO_MEDIA_HLS_URL: 'http://127.0.0.1:8888',
      NINO_MEDIA_RTSP_URL: 'rtsp://127.0.0.1:8554',
      NINO_MEDIA_RTMP_URL: 'rtmp://127.0.0.1:1935',
      NINO_MEDIA_PATH: 'nino/program',
      PATH: [dirname(layout.nodePath), layout.ffmpegRoot, process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':'),
    };
    await startService({ service: 'media', layout, executable: layout.mediaPath, args: [layout.mediaConfigPath],
      anchor: layout.mediaConfigPath, ports: MEDIA_PORTS, env, timeoutSeconds: options.timeoutSeconds });
    await startService({ service: 'api', layout, executable: layout.nodePath, args: [layout.entryPath, layout.apiAnchor],
      anchor: layout.apiAnchor, ports: API_PORTS, env, timeoutSeconds: options.timeoutSeconds });
    let obsWarning = null;
    if (!options.noObs && !obsRunning()) {
      const obs = findObs(settings.obsPath);
      if (obs) spawnSync('/usr/bin/open', ['-a', obs], { timeout: 30_000 });
      else obsWarning = 'Nino est ouvert. Installez OBS Studio depuis https://obsproject.com/download, puis relancez Nino. Dans Nino, connectez ensuite OBS : ouvrir OBS ne démarre aucun enregistrement ni live.';
    }
    if (!options.noBrowser) spawnSync('/usr/bin/open', ['http://127.0.0.1:4310/'], { timeout: 30_000 });
    console.log('Nino est disponible : http://127.0.0.1:4310/ . Aucun enregistrement ni live n’a été lancé.');
    if (obsWarning) showMessage(obsWarning, { dialogs });
    return 0;
  } catch (error) {
    let message = error instanceof LauncherError ? error.message : `Erreur inattendue : ${error?.message ?? error}`;
    if (layout) {
      message += `\n\nJournaux : ${layout.logRoot}`;
      await appendFile(join(layout.logRoot, 'launcher.log'), `${new Date().toISOString()} ${error?.stack ?? error}\n`).catch(() => {});
    }
    showMessage(message, { error: true, dialogs: !options.noDialogs });
    return 1;
  } finally {
    if (release) await release();
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const resources = dirname(dirname(fileURLToPath(import.meta.url)));
  process.exitCode = await runLauncher(resources, process.argv.slice(2));
}
