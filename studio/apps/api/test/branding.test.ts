import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { Store, type PrivateRoom } from '../src/store.js';

test('branding migrates the default room name while retaining production settings and device access', async (t) => {
  for (const name of ['Studio GabinHEdS', 'Salle vidéo principale']) {
    await t.test(name, async (t) => {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nino-branding-'));
      const store = new Store(dataDir);
      const room: PrivateRoom = {
        name, obsUrl: 'ws://127.0.0.1:4455', obsPassword: 'fixture-obs-password', obsPasswordConfigured: true,
        recordingRoot: path.join(dataDir, 'existing-recordings'), defaultScenes: { podcast: 'Interview', roundtable: 'Table ronde', slides: 'Présentation' },
        liveDestination: { name: 'YouTube', server: 'rtmps://example.com/live', keyConfigured: true }, liveKey: 'fixture-live-key',
      };
      store.saveRoom(room);
      const paired = store.createDevice('iPad existant', 'ipad', 'operator');
      store.close();

      let app = await buildApp({ dataDir });
      t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
      const headers = { authorization: `Bearer ${paired.token}` };
      const expectedName = name === 'Studio GabinHEdS' ? 'Studio Nino' : name;
      let response = await app.inject({ method: 'GET', url: '/api/state', headers });
      assert.equal(response.statusCode, 200);
      const { obsPassword: _password, liveKey: _key, ...publicRoom } = room;
      assert.deepEqual(response.json().room, { ...publicRoom, name: expectedName });
      await app.close();

      const migrated = new Store(dataDir);
      assert.deepEqual(migrated.room(), { ...room, name: expectedName });
      assert.equal(migrated.deviceForToken(paired.token)?.id, paired.device.id);
      migrated.close();

      app = await buildApp({ dataDir });
      response = await app.inject({ method: 'GET', url: '/api/state', headers });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().room.name, expectedName);
      assert.equal(response.json().room.recordingRoot, room.recordingRoot);
    });
  }
});
