import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface WindowsStudioOpenerOptions {
  platform?: NodeJS.Platform;
  moduleUrl?: string;
  systemRoot?: string;
  exists?: typeof existsSync;
  spawnProcess?: typeof spawn;
}

/** Fixed local launcher only. No value comes from a controller, URL or command body. */
export function createWindowsStudioOpener(options: WindowsStudioOpenerOptions = {}): (() => Promise<void>) | undefined {
  if ((options.platform ?? process.platform) !== 'win32') return undefined;
  const moduleDirectory = path.dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
  // Installed: <installation>/app/apps/api/src. Development: <studio>/apps/api/src.
  const candidates = [path.resolve(moduleDirectory, '../../../../windows/Launch-Nino.ps1'), path.resolve(moduleDirectory, '../../../windows/Launch-Nino.ps1')];
  const exists = options.exists ?? existsSync;
  const spawnProcess = options.spawnProcess ?? spawn;
  let active: { process: ChildProcess; accepted: Promise<void> } | null = null;
  return () => {
    if (active) return active.accepted;
    const launcher = candidates.find(candidate => exists(candidate));
    if (!launcher) return Promise.reject(new Error('Le lanceur Windows Nino installé est introuvable.'));
    const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
    if (!/^[a-zA-Z]:[\\/]/.test(systemRoot) || /[\0\r\n]/.test(systemRoot)) return Promise.reject(new Error('Le dossier système Windows est invalide.'));
    const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let child: ChildProcess;
    try {
      child = spawnProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher], {
        cwd: path.dirname(launcher), shell: false, windowsHide: true, stdio: 'ignore',
      });
    } catch { return Promise.reject(new Error('Le processus du lanceur Windows n’a pas pu démarrer.')); }
    const accepted = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => { child.unref(); resolve(); });
      child.once('error', () => { if (active?.process === child) active = null; reject(new Error('Le processus du lanceur Windows n’a pas pu démarrer.')); });
    });
    active = { process: child, accepted };
    child.once('close', () => { if (active?.process === child) active = null; });
    return accepted;
  };
}
