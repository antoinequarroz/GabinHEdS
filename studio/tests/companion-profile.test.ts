import test from 'node:test';
import assert from 'node:assert/strict';
// Native Companion exports are JSON, intentionally usable without the API TS runtime.
// @ts-expect-error JavaScript authoring utility has no declaration file.
import { upgradeCompanionProfile, FRESH } from '../scripts/companion-profile.mjs';

const V = (value: unknown) => ({ value, isExpression: false });
const template = () => ({ type: 'button-layered', options: {}, feedbacks: [], localVariables: [], style: { layers: [{ id: 'canvas', type: 'canvas' }, { id: 'image', type: 'image', base64Image: V('data:image/png;base64,placeholder') }] }, steps: { '0': { action_sets: { down: [], up: [] } } } });
const page = () => ({ type: 'page', page: { name: 'Nino · Menu', controls: Object.fromEntries([0, 1, 2].map(row => [row, Object.fromEntries([0, 1, 2, 3, 4].map(column => [column, template()]))])) }, instances: { http: { moduleId: 'generic-http', config: { host: 'http://127.0.0.1:4310' } } } });
const values: Record<string, unknown> = { nino_state_online: 1, nino_state_updated_at: 100, nino_project_id: 'one', nino_suite_binding_project_id: 'one', nino_state_project_id: 'one', nino_token: 'fake-test-token', nino_state_obs_connected: 1, nino_state_recording: 0, nino_state_launch_status: 'idle' };
const evaluate = (expression: string, vars = values, now = 100) => Function('concat', `return (${expression.replace(/\$\(custom:([^)]*)\)/g, (_, name) => JSON.stringify(vars[name] ?? '')).replaceAll('$(internal:time_unix)', String(now))});`)((...parts: unknown[]) => parts.join(''));

test('Menu adds a guarded local launch, preserves navigation, and never embeds a token', () => {
  const before = page();
  const upgraded = upgradeCompanionProfile(before, 'menu');
  const actions = upgraded.page.controls['0']['4'].steps['0'].action_sets.down;
  const condition = actions[0].children.condition[0].options.expression.value;
  assert.equal(evaluate(condition), true);
  assert.equal(evaluate(condition, values, 105), false, 'dead Nino process must not leave controls armed');
  assert.equal(evaluate(condition, values, 99), false, 'future heartbeat is not current');
  assert.equal(evaluate(condition, { ...values, nino_suite_binding_project_id: '' }), false);
  assert.equal(evaluate(condition, { ...values, nino_state_project_id: 'other' }), false);
  assert.equal(evaluate(condition, { ...values, nino_token: '' }), false);
  assert.equal(evaluate(condition, { ...values, nino_state_recording: 1 }), false);
  assert.equal(evaluate(condition, { ...values, nino_state_launch_status: 'running' }), false);
  assert.equal(evaluate(condition, { ...values, nino_state_obs_connected: 0 }), false);
  assert.equal(evaluate(condition, { ...values, nino_state_project_conflict: 1 }), false, 'another project is never controlled by stale project buttons');
  assert.deepEqual(JSON.parse(actions[0].children.actions[0].options.body.value), { action: 'production.start', projectId: '$(custom:nino_project_id)', includeLive: false });
  assert.deepEqual(upgraded.page.controls['0']['0'], before.page.controls['0']['0']);
  assert.ok(!JSON.stringify(upgraded).includes('fake-test-token'));
});

test('recording status is dynamic and switches to unavailable when heartbeat expires', () => {
  const original = page(); original.page.name = 'Nino · Régie';
  (original.page.controls['0']['0'].steps['0'].action_sets.down as unknown[]) = [{ type: 'action', connectionId: 'internal', definitionId: 'logic_if', options: {}, children: { condition: [{ options: { expression: V('!!$(custom:nino_token)') } }], actions: [{ definitionId: 'post', options: { body: V('{"action":"record.start","projectId":"$(custom:nino_project_id)"}') } }] } }];
  const upgraded = upgradeCompanionProfile(original, 'regie');
  const layer = upgraded.page.controls['0']['0'].style.layers.find((element: { name: string }) => element.name === 'Nino · État réel');
  assert.match(layer.text.value, /concat\(/, 'Companion arithmetic + does not concatenate labels by default');
  const running = { ...values, nino_state_recording: 1, nino_state_paused: 0, nino_state_record_timecode: '00:02:16' };
  assert.equal(evaluate(layer.text.value, running), 'REC 00:02:16');
  assert.equal(evaluate(layer.text.value, { ...running, nino_state_paused: 1 }), 'PAUSE 00:02:16');
  assert.equal(evaluate(layer.text.value, running, 105), 'NINO HORS LIGNE');
  assert.equal(evaluate(layer.text.value, { ...running, nino_state_obs_connected: 0 }), 'OBS DÉCONNECTÉ');
  assert.equal(evaluate(layer.text.value, { ...running, nino_state_project_conflict: 1 }), 'AUTRE PRODUCTION');
  assert.equal(evaluate(FRESH, running, 104), true);
});

test('a navigation-only Menu export can reuse the existing Nino HTTP connection', () => {
  const original = page();
  const connection = { id: 'http', instance: original.instances.http };
  original.instances = {} as typeof original.instances;
  const upgraded = upgradeCompanionProfile(original, 'menu', connection);
  assert.deepEqual(upgraded.instances.http, connection.instance);
  const action = upgraded.page.controls['0']['4'].steps['0'].action_sets.down[0].children.actions[0];
  assert.equal(action.connectionId, 'http');
});

test('clear activity borders distinguish REC, pause and stop without lighting every command', () => {
  const original = page(); original.page.name = 'Nino · Régie';
  const actions = ['record.start', 'record.stop', 'record.pause', 'record.resume', 'marker.add'];
  for (const [column, action] of actions.entries()) {
    (original.page.controls['0'][String(column) as '0'].steps['0'].action_sets.down as unknown[]) = [{ type: 'action', connectionId: 'internal', definitionId: 'logic_if', options: {}, children: { condition: [{ options: { expression: V('!!$(custom:nino_token)') } }], actions: [{ definitionId: 'post', options: { body: V(JSON.stringify({ action, projectId: '$(custom:nino_project_id)' })) } }] } }];
  }
  const upgraded = upgradeCompanionProfile(original, 'regie');
  const led = (column: number) => upgraded.page.controls['0'][column].style.layers.find((layer: { name: string }) => layer.name === 'Nino · État voyant');
  const running = { ...values, nino_state_recording: 1, nino_state_paused: 0 };
  assert.equal(evaluate(led(0).enabled.value, running), true);
  for (const column of [1, 2, 3, 4]) assert.equal(evaluate(led(column).enabled.value, running), false);
  assert.equal(evaluate(led(2).enabled.value, { ...running, nino_state_paused: 1 }), true);
  assert.equal(led(2).color.value, 0xf1c27b, 'confirmed pause uses amber');
  const band = upgraded.page.controls['0']['0'].style.layers.find((layer: { name: string }) => layer.name === 'Nino · État fond');
  assert.equal(band.height.value, 24);
});
