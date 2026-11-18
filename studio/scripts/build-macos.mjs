// Builds Nino.app for macOS (Apple Silicon) from this checkout.
// Run on a macOS arm64 machine after `npm ci && npm run build`, so native npm
// dependencies match the target. FFmpeg is not redistributed: the launcher
// downloads the pinned build on first launch (see macos/runtime-lock.json).
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const studio = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build Nino.app on macOS arm64 so native npm dependencies match the target.');
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('Usage: node scripts/build-macos.mjs --output <empty-directory>');
const destination = resolve(args[outputIndex + 1]);
const contains = (parent, child) => {
  const part = relative(parent, child);
  return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
};
if (contains(studio, destination) || contains(destination, studio)) throw new Error('Refusing an overlapping application source/output directory.');
await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length) throw new Error('The macOS output directory must be empty.');

const version = JSON.parse(await readFile(join(studio, 'package.json'), 'utf8')).version;
const lock = JSON.parse(await readFile(join(studio, 'macos/runtime-lock.json'), 'utf8'));
const bundle = join(destination, 'Nino.app');
const contents = join(bundle, 'Contents');
const resources = join(contents, 'Resources');
const app = join(resources, 'app');
const work = join(destination, '.work');
await mkdir(work);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const download = async (name, spec) => {
  if (!/^https:\/\//.test(spec.url) || !/^[a-f0-9]{64}$/.test(spec.sha256)) throw new Error(`Invalid locked runtime: ${name}`);
  const response = await fetch(spec.url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`${name} download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== spec.sha256) throw new Error(`${name} checksum mismatch.`);
  const archive = join(work, `${name}.tar.gz`);
  await writeFile(archive, bytes);
  const extraction = join(work, name);
  await mkdir(extraction);
  const result = spawnSync('tar', ['-xzf', archive, '-C', extraction], { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${name} extraction failed: ${result.stderr}`);
  return extraction;
};
const permitted = source => {
  const name = basename(source);
  return !['.data', '.git', '.cache', 'test-results', '.bin'].includes(name) && !name.startsWith('.env')
    && !/\.(sqlite(?:-wal|-shm)?|db|log|mp4|mkv|mov|webm|wav|mp3|m4a|aac)$/i.test(name);
};

// 1. The API is bundled ahead of time: no TypeScript loader (tsx/esbuild) runs on
// the Mac. Workspace code (@nino/shared) is inlined; npm packages stay external.
await build({
  entryPoints: [join(studio, 'apps/api/src/index.ts')],
  outfile: join(app, 'apps/api/dist/index.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24', sourcemap: false, logLevel: 'warning',
  plugins: [{
    name: 'external-npm-packages',
    setup(context) {
      context.onResolve({ filter: /^[^./]/ }, ({ path }) => path.startsWith('@nino/') ? undefined : { path, external: true });
    },
  }],
});
// 2. Application files. The API's `../../web/dist` lookup stays valid from apps/api/dist.
for (const file of ['package.json', 'package-lock.json', 'README.md', 'docs', 'config/mediamtx.yml', 'config/stream-deck',
  'apps/api/package.json', 'apps/web/package.json', 'apps/web/dist']) {
  await mkdir(dirname(join(app, file)), { recursive: true });
  await cp(join(studio, file), join(app, file), { recursive: true, filter: permitted });
}
await cp(join(studio, 'node_modules'), join(app, 'node_modules'), {
  recursive: true, dereference: true,
  // Workspace links are replaced by the bundle above; build-only tools are not needed at runtime.
  filter: source => permitted(source) && !contains(join(studio, 'node_modules/@nino'), source),
});
for (const workspace of ['apps/api']) {
  try {
    await cp(join(studio, workspace, 'node_modules'), join(app, workspace, 'node_modules'), { recursive: true, dereference: true, filter: permitted });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// 3. Locked runtimes, verified by SHA-256.
const [nodeDir, mediaDir] = await Promise.all([download('node', lock.node), download('mediamtx', lock.mediamtx)]);
await mkdir(join(resources, 'runtime/node/bin'), { recursive: true });
await cp(join(nodeDir, lock.node.archiveRoot, 'bin/node'), join(resources, 'runtime/node/bin/node'));
await cp(join(nodeDir, lock.node.archiveRoot, 'LICENSE'), join(resources, 'runtime/node/LICENSE'));
await mkdir(join(resources, 'runtime/mediamtx'), { recursive: true });
await cp(join(mediaDir, 'mediamtx'), join(resources, 'runtime/mediamtx/mediamtx'));
const licenseResponse = await fetch(`https://raw.githubusercontent.com/bluenviron/mediamtx/v${lock.mediamtx.version}/LICENSE`, { signal: AbortSignal.timeout(20_000) });
if (!licenseResponse.ok) throw new Error('MediaMTX license unavailable.');
await writeFile(join(resources, 'runtime/mediamtx/LICENSE'), await licenseResponse.text());
await rm(work, { recursive: true });
// 4. Launcher, icon and bundle metadata.
await mkdir(join(resources, 'macos'), { recursive: true });
for (const file of ['launcher.mjs', 'runtime-lock.json']) await cp(join(studio, 'macos', file), join(resources, 'macos', file));
await cp(join(studio, 'macos/nino.icns'), join(resources, 'nino.icns'));
await mkdir(join(contents, 'MacOS'), { recursive: true });
await writeFile(join(contents, 'MacOS/Nino'), [
  '#!/bin/sh',
  '# Nino launcher: starts the local services with the bundled Node.js runtime.',
  'resources="$(cd "$(dirname "$0")/../Resources" && pwd)" || exit 1',
  'exec "$resources/runtime/node/bin/node" "$resources/macos/launcher.mjs" "$@"',
  '',
].join('\n'));
for (const executable of ['MacOS/Nino', 'Resources/runtime/node/bin/node', 'Resources/runtime/mediamtx/mediamtx']) await chmod(join(contents, executable), 0o755);
const revision = process.env.GITHUB_SHA ?? 'local';
const plist = (await readFile(join(studio, 'macos/Info.plist'), 'utf8'))
  .replaceAll('@VERSION@', version).replaceAll('@REVISION@', revision.slice(0, 12));
await writeFile(join(contents, 'Info.plist'), plist);
await writeFile(join(contents, 'PkgInfo'), 'APPL????');
const metadata = {
  product: 'Nino', platform: 'macos-arm64', revision, version,
  runtimes: { node: lock.node, mediamtx: lock.mediamtx }, firstLaunchDownload: { ffmpeg: lock.ffmpeg },
};
await writeFile(join(resources, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(join(resources, 'THIRD-PARTY-NOTICES.txt'), [
  'Nino - composants tiers', '',
  `Node.js : licence incluse dans runtime/node/LICENSE ; source https://github.com/nodejs/node/tree/v${lock.node.version}`,
  `MediaMTX : licence incluse dans runtime/mediamtx/LICENSE ; source https://github.com/bluenviron/mediamtx/tree/v${lock.mediamtx.version}`,
  'Les licences des dependances npm sont conservees dans app/node_modules.',
  'FFmpeg et ffprobe sont telecharges au premier lancement directement chez leur fournisseur, sans etre redistribues dans Nino.app.',
  `FFmpeg : ${lock.ffmpeg.source}`, '',
].join('\n'));
const required = ['Contents/Info.plist', 'Contents/MacOS/Nino', 'Contents/Resources/nino.icns',
  'Contents/Resources/app/apps/web/dist/index.html', 'Contents/Resources/app/apps/api/dist/index.mjs',
  'Contents/Resources/app/node_modules/fastify/package.json', 'Contents/Resources/app/node_modules/ws/index.js',
  'Contents/Resources/runtime/node/bin/node', 'Contents/Resources/runtime/mediamtx/mediamtx',
  'Contents/Resources/app/config/mediamtx.yml', 'Contents/Resources/macos/launcher.mjs', 'Contents/Resources/macos/runtime-lock.json',
  'Contents/Resources/app/docs/guides/nino-installation-salle.pdf', 'Contents/Resources/app/config/stream-deck/README.md'];
for (const file of required) await readFile(join(bundle, file));
console.log(JSON.stringify({ bundle, version, revision, requiredFiles: required.length }, null, 2));
