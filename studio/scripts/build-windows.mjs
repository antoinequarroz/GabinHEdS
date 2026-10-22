import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const studio = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this payload on Windows x64 so native npm dependencies match the target.');
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('Usage: node scripts/build-windows.mjs --output <empty-directory>');
const destination = resolve(args[outputIndex + 1]);
const contains = (parent, child) => {
  const part = relative(parent, child);
  return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
};
if (contains(studio, destination) || contains(destination, studio)) throw new Error('Refusing an overlapping application source/output directory.');
await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length) throw new Error('The Windows payload directory must be empty.');
const lock = JSON.parse(await readFile(join(studio, 'windows/runtime-lock.json'), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const download = async (name, spec) => {
  if (!/^https:\/\//.test(spec.url) || !/^[a-f0-9]{64}$/.test(spec.sha256)) throw new Error(`Invalid locked runtime: ${name}`);
  const response = await fetch(spec.url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`${name} download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== spec.sha256) throw new Error(`${name} checksum mismatch.`);
  const archive = join(destination, `${name}.zip`);
  await writeFile(archive, bytes);
  const extraction = join(destination, `.extract-${name}`);
  await mkdir(extraction);
  const result = spawnSync('tar', ['-xf', archive, '-C', extraction], { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`${name} extraction failed: ${result.stderr}`);
  return { archive, extraction };
};
const permitted = source => {
  const name = basename(source);
  return !['.data', '.git', '.cache', 'test-results', '.bin'].includes(name) && !name.startsWith('.env')
    && !/\.(sqlite(?:-wal|-shm)?|db|log|mp4|mkv|mov|webm|wav|mp3|m4a|aac)$/i.test(name);
};
const appFiles = ['package.json', 'package-lock.json', 'README.md', 'docs', 'config/mediamtx.yml', 'config/stream-deck',
  'apps/api/package.json', 'apps/api/src', 'apps/web/package.json', 'apps/web/dist',
  'packages/shared/package.json', 'packages/shared/src'];
for (const file of appFiles) {
  await mkdir(dirname(join(destination, 'app', file)), { recursive: true });
  await cp(join(studio, file), join(destination, 'app', file), { recursive: true, filter: permitted });
}
// Native modules (notably esbuild/tsx) must come from npm ci on THIS Windows runner.
await cp(join(studio, 'node_modules'), join(destination, 'app/node_modules'), { recursive: true, dereference: true, filter: permitted });
// npm workspaces may use package-local node_modules; retain those if present.
for (const workspace of ['apps/api', 'packages/shared']) {
  try {
    await cp(join(studio, workspace, 'node_modules'), join(destination, 'app', workspace, 'node_modules'), { recursive: true, dereference: true, filter: permitted });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await cp(join(studio, 'windows'), join(destination, 'windows'), {
  recursive: true, filter: source => permitted(source) && !['nino.iss', 'tests', 'Smoke-Installer.ps1'].includes(basename(source)),
});
const packages = await Promise.all([download('node', lock.node), download('mediamtx', lock.mediamtx)]);
await mkdir(join(destination, 'runtime/node'), { recursive: true });
await cp(join(packages[0].extraction, lock.node.archiveRoot, 'node.exe'), join(destination, 'runtime/node/node.exe'));
await cp(join(packages[0].extraction, lock.node.archiveRoot, 'LICENSE'), join(destination, 'runtime/node/LICENSE'));
await mkdir(join(destination, 'runtime/mediamtx'), { recursive: true });
await cp(join(packages[1].extraction, 'mediamtx.exe'), join(destination, 'runtime/mediamtx/mediamtx.exe'));
const licenseResponse = await fetch('https://raw.githubusercontent.com/bluenviron/mediamtx/v1.21.2/LICENSE', { signal: AbortSignal.timeout(20_000) });
if (!licenseResponse.ok) throw new Error('MediaMTX license unavailable.');
await writeFile(join(destination, 'runtime/mediamtx/LICENSE'), await licenseResponse.text());
for (const { archive, extraction } of packages) { await rm(archive); await rm(extraction, { recursive: true }); }
const metadata = {
  product: 'Nino', platform: 'windows-x64', revision: process.env.GITHUB_SHA ?? 'local',
  version: JSON.parse(await readFile(join(studio, 'package.json'), 'utf8')).version,
  runtimes: { node: lock.node, mediamtx: lock.mediamtx }, firstInstallDownload: { ffmpeg: lock.ffmpeg, optionalObs: lock.obs },
};
await writeFile(join(destination, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(join(destination, 'THIRD-PARTY-NOTICES.txt'), [
  'Nino - composants tiers', '',
  'Node.js : licence incluse dans runtime/node/LICENSE ; source https://github.com/nodejs/node/tree/v24.22.0',
  'MediaMTX : licence incluse dans runtime/mediamtx/LICENSE ; source https://github.com/bluenviron/mediamtx/tree/v1.21.2',
  'Les licences des dependances npm sont conservees dans app/node_modules.',
  'FFmpeg est telecharge directement chez son fournisseur pendant la preparation, sans etre redistribue dans ce Setup.',
  'Son paquet complet conserve ses licences, README, liens de sources et sa configuration de construction dans le dossier utilisateur.',
  `FFmpeg : ${lock.ffmpeg.source}`,
  'L installation optionnelle OBS utilise son installateur officiel, telecharge et verifie avant ouverture.',
  `OBS : ${lock.obs.source}`, '',
].join('\n'));
const required = ['app/apps/web/dist/index.html', 'app/node_modules/tsx/dist/loader.mjs', 'app/node_modules/@esbuild/win32-x64/esbuild.exe',
  'runtime/node/node.exe', 'runtime/mediamtx/mediamtx.exe', 'windows/Launch-Nino.ps1', 'windows/Prepare-Runtime.ps1', 'windows/Start-Companion.ps1',
  'windows/nino.ico', 'app/docs/guides/nino-installation-salle.pdf', 'app/node_modules/ws/index.js',
  'app/config/stream-deck/README.md', 'app/config/stream-deck/Nino-Accueil.companionconfig',
  'app/apps/api/src/windows-studio-opener.ts'];
for (const file of required) await readFile(join(destination, file));
console.log(JSON.stringify({ payload: destination, revision: metadata.revision, requiredFiles: required.length }, null, 2));
