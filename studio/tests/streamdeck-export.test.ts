import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error Offline JSON authoring utility has no declaration file.
import { profileFiles, navigationDefaults, assertShareableProfile, buildStreamDeckProfiles } from '../scripts/build-streamdeck.mjs';

const directory = new URL('../config/stream-deck/', import.meta.url);
const load = async (file: string) => JSON.parse(await readFile(new URL(file, directory), 'utf8'));
const controls = (page: any) => Object.values(page.page.controls).flatMap((row: any) => Object.values(row)) as any[];
const commands = (page: any) => controls(page).flatMap(control => control.steps?.['0']?.action_sets?.down || []);
const posts = (page: any) => commands(page).flatMap(command => command.children?.actions || []);

test('published pages contain the complete MK.2 controls, guarded authenticated production commands and embedded glyphs', async () => {
  const connectionIds = new Set<string>();
  const navigationNames = new Set<string>();
  let launchCount = 0;
  for (const [key, file] of Object.entries(profileFiles) as [string, string][]) {
    const page = await load(file);
    assertShareableProfile(page, file);
    assert.equal(controls(page).length, 15);
    assert.deepEqual(Object.keys(page.page.controls).sort(), ['0', '1', '2']);
    for (const row of Object.values(page.page.controls) as any[]) assert.deepEqual(Object.keys(row).sort(), ['0', '1', '2', '3', '4']);
    assert.equal(page.customVariables, undefined, 'a page must not carry a global credential export');
    for (const [id, instance] of Object.entries(page.instances) as [string, any][]) {
      connectionIds.add(id);
      assert.equal(instance.moduleId, 'generic-http');
      assert.equal(instance.config.prefix, 'http://127.0.0.1:4310');
    }
    for (const action of commands(page)) {
      if (action.definitionId === 'set_page') {
        assert.equal(action.options.surfaceId.value, 'self');
        assert.equal(action.options.page.isExpression, true);
        navigationNames.add(action.options.page.value);
      } else {
        const guard = action.children.condition[0].options.expression.value;
        assert.ok(guard.includes('internal:time_unix'));
        assert.ok(guard.includes('nino_suite_binding_project_id'));
        assert.ok(guard.includes('nino_state_project_conflict'));
      }
    }
    for (const action of posts(page)) {
      assert.equal(action.options.url.value, '/api/control');
      assert.deepEqual(JSON.parse(action.options.header.value), { Authorization: 'Bearer $(custom:nino_token)' });
      const payload = JSON.parse(action.options.body.value);
      if (payload.action === 'production.start') {
        launchCount++;
        assert.equal(key, 'menu');
        assert.equal(payload.includeLive, false);
        assert.equal(payload.projectId, '$(custom:nino_project_id)');
      }
      if (payload.action === 'media.play') assert.match(payload.assetId, /^\$\(custom:nino_suite_asset_(intro|outro|logo|music)\)$/);
    }
    const images = controls(page).flatMap(control => control.style.layers).filter(layer => layer.type === 'image');
    assert.ok(images.length >= 4, 'committed pages include their own raster glyphs');
    for (const image of images) assert.ok(image.base64Image.value.includes('data:image/png;base64,iVBOR'), 'no local image file is needed');
  }
  assert.equal(connectionIds.size, 1, 'the five pages are designed to reuse one Nino connection');
  assert.equal(launchCount, 1);
  assert.deepEqual([...navigationNames].sort(), Object.keys(navigationDefaults).map(name => `$(custom:${name})`).sort());
});

test('all five page exports can be regenerated using only published repository inputs', async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'nino-streamdeck-exports-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const hashes = async () => Promise.all((Object.values(profileFiles) as string[]).map(async file => createHash('sha256').update(await readFile(new URL(file, directory))).digest('hex')));
  const before = await hashes();
  const result = await buildStreamDeckProfiles(output);
  assert.equal(result.credentialsIncluded, false);
  assert.equal(result.files.length, 5);
  for (const file of result.files) assertShareableProfile(JSON.parse(await readFile(path.join(output, file), 'utf8')), file);
  assert.deepEqual(JSON.parse(await readFile(path.join(output, 'variables-navigation.json'), 'utf8')), navigationDefaults);
  assert.ok((await readFile(path.join(output, 'README.md'), 'utf8')).includes('Tout lancer'));
  assert.deepEqual(await hashes(), before, 'regeneration leaves the committed source templates unchanged');
});

test('the export validation rejects a literal device credential or an unguarded action', async () => {
  const menu = await load(profileFiles.menu);
  const post = posts(menu)[0];
  post.options.header.value = '{"Authorization":"Bearer fake-credential-sentinel"}';
  assert.throws(() => assertShareableProfile(menu), /identifiant littéral|Accès opérateur/);
  const page = await load(profileFiles.regie);
  commands(page)[0].children.condition[0].options.expression.value = 'true';
  assert.throws(() => assertShareableProfile(page), /Garde de production/);
});
