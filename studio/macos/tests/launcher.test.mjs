import test from 'node:test';
import assert from 'node:assert/strict';
import { getLayout, matchesRecord, parseArguments, parseLsof, parseSettings } from '../launcher.mjs';

test('settings accept only the documented keys and types', () => {
  assert.deepEqual(parseSettings(undefined, 'x'), { listenOnLan: false, obsPath: null });
  assert.deepEqual(parseSettings('{"listenOnLan":true,"obsPath":"/Applications/OBS.app"}', 'x'), { listenOnLan: true, obsPath: '/Applications/OBS.app' });
  assert.throws(() => parseSettings('[]', 'x'), /objet JSON/);
  assert.throws(() => parseSettings('{"listenOnLan":"yes"}', 'x'), /booléen/);
  assert.throws(() => parseSettings('{"obsPath":"OBS.app"}', 'x'), /OBS.app/);
  assert.throws(() => parseSettings('{"autoRecord":true}', 'x'), /inconnu/);
  assert.throws(() => parseSettings('{', 'x'), /invalide/);
});

test('arguments are explicit; Finder process serial numbers are ignored', () => {
  assert.deepEqual(parseArguments(['--stop', '--no-dialogs']), { stop: true, noBrowser: false, noObs: false, noDialogs: true, timeoutSeconds: 90 });
  assert.equal(parseArguments(['-psn_0_12345']).stop, false);
  assert.throws(() => parseArguments(['--record']), /inconnue/);
});

test('lsof field output maps listeners to their process', () => {
  const owners = parseLsof('p123\nf5\nn127.0.0.1:4310\nn*:4312\np456\nf7\nn[::1]:9997\n');
  assert.deepEqual(owners, [{ pid: 123, port: 4310 }, { pid: 123, port: 4312 }, { pid: 456, port: 9997 }]);
});

test('a process is ours only with the same pid, start time and anchor', () => {
  const record = { pid: 42, startedAt: 'Wed Nov 18 09:00:00 2026', anchor: '--nino-owner=abc' };
  const info = { startedAt: 'Wed Nov 18 09:00:00 2026', command: '/x/node /x/index.mjs --nino-owner=abc' };
  assert.equal(matchesRecord(record, info, '--nino-owner=abc'), true);
  assert.equal(matchesRecord(record, { ...info, startedAt: 'Wed Nov 18 09:00:01 2026' }, '--nino-owner=abc'), false);
  assert.equal(matchesRecord(record, { ...info, command: '/x/node other.mjs' }, '--nino-owner=abc'), false);
  assert.equal(matchesRecord(record, null, '--nino-owner=abc'), false);
});

test('user files live outside the app bundle', () => {
  const layout = getLayout('/Applications/Nino.app/Contents/Resources', { mediamtx: { version: '1.21.2' }, ffmpeg: { version: '6.1.1' } }, '/Users/salle', '');
  assert.equal(layout.userRoot, '/Users/salle/Library/Application Support/Nino');
  assert.equal(layout.mediaPath, '/Users/salle/Library/Application Support/Nino/runtime/mediamtx/1.21.2/mediamtx');
  assert.equal(layout.ffprobePath, '/Users/salle/Library/Application Support/Nino/runtime/ffmpeg/6.1.1/ffprobe');
  assert.equal(layout.entryPath, '/Applications/Nino.app/Contents/Resources/app/apps/api/dist/index.mjs');
});
