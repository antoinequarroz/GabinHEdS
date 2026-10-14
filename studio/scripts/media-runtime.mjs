import { homedir } from 'node:os';
import { join } from 'node:path';

export const version = 'v1.21.2';
export const platform = process.platform;
export const architecture = { arm64: 'arm64', x64: 'amd64' }[process.arch];
export const directory = join(homedir(), '.cache', 'gabin-studio', 'mediamtx', version, `${platform}-${process.arch}`);
export const executable = join(directory, platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
