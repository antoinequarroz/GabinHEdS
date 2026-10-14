import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Encoded mire/sine fixtures for library and completed-playback tests. No
 * camera, microphone, production data, or network inputs are accessed. */
export async function createMediaFixture(directory: string) {
  await mkdir(directory, { recursive: true });
  const ffmpeg = process.env.GABIN_FFMPEG_PATH ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
  const mkv = join(directory, 'intro-test.mkv');
  const mp4 = join(directory, 'intro-test.mp4');
  const image = join(directory, 'logo-test.png');
  const audio = join(directory, 'musique-test.wav');
  const options = { timeout: 30_000, maxBuffer: 64 * 1024 };
  await execute(ffmpeg, ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', mkv], options);
  await execute(ffmpeg, ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', mkv, '-c', 'copy', '-movflags', '+faststart', mp4], options);
  await execute(ffmpeg, ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x62758f:s=640x360', '-frames:v', '1', '-threads', '1', image], options);
  await execute(ffmpeg, ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', audio], options);
  return { mkv, mp4, image, audio };
}
