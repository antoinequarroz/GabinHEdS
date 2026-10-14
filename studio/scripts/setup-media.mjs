import { mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { version, platform, architecture, directory, executable } from './media-runtime.mjs';

if (!architecture || !['darwin', 'linux', 'win32'].includes(platform)) throw new Error('Plateforme non prise en charge. Installez MediaMTX manuellement.');
const release = await fetch(`https://api.github.com/repos/bluenviron/mediamtx/releases/tags/${version}`, {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GabinHEdS-local-setup',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }, signal: AbortSignal.timeout(20000),
});
if (!release.ok) throw new Error(`La version MediaMTX ${version} n’est pas accessible (${release.status}).`);
const metadata = await release.json();
const extension = platform === 'win32' ? 'zip' : 'tar.gz';
const assetName = `mediamtx_${version}_${platform === 'win32' ? 'windows' : platform}_${architecture}.${extension}`;
const asset = metadata.assets.find(item => item.name === assetName);
if (!asset?.digest?.startsWith('sha256:')) throw new Error('Archive ou empreinte officielle indisponible.');
const archiveResponse = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
if (!archiveResponse.ok) throw new Error('Téléchargement de MediaMTX impossible.');
const contents = Buffer.from(await archiveResponse.arrayBuffer());
const digest = createHash('sha256').update(contents).digest('hex');
if (`sha256:${digest}` !== asset.digest) throw new Error('L’empreinte de l’archive MediaMTX ne correspond pas à celle de la publication officielle.');
await mkdir(directory, { recursive: true, mode: 0o700 });
const archive = join(directory, `release.${extension}`);
await writeFile(archive, contents);
// Extract a single executable from the verified release; keep the reviewed
// configuration in the repository instead of running the bundled default.
try {
  const extraction = spawnSync('tar', ['-xf', archive, '-C', directory, platform === 'win32' ? 'mediamtx.exe' : 'mediamtx'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (extraction.status !== 0) throw new Error('Extraction impossible. Utilisez tar ou installez MediaMTX manuellement.');
  if (platform !== 'win32') await chmod(executable, 0o755);
} finally { await rm(archive, { force: true }); }
console.log(JSON.stringify({ version, executable, sha256: digest }, null, 2));
