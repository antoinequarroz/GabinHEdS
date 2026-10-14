import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { executable } from './media-runtime.mjs';

const binary = process.env.GABIN_MEDIAMTX_PATH ?? executable;
if (!existsSync(binary)) throw new Error('MediaMTX manque. Exécutez npm run setup:media ou définissez GABIN_MEDIAMTX_PATH.');
const configuration = fileURLToPath(new URL('../config/mediamtx.yml', import.meta.url));
const child = spawn(binary, [configuration], { stdio: 'inherit', windowsHide: true });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child.kill(signal); });
child.once('error', () => { console.error('Impossible de lancer MediaMTX. Vérifiez son installation.'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? (stopping ? 0 : 1); });
