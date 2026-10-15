import test from 'node:test';
import assert from 'node:assert/strict';
import { RealObsGateway, type ObsGuestSourceOptions } from '../apps/api/src/obs.js';
import { startFakeObs } from './fake-obs.js';

const guestOptions = (): ObsGuestSourceOptions => ({
  ownerId: 'nino.remoteguests', projectId: 'test-project-1', sceneNames: ['Table ronde', 'Caméra 1', 'Plan large'],
  guests: [1, 2].map(slot => ({ id: `guest-${slot}`, slot: slot as 1 | 2, name: `Invité ${slot}`,
    inputName: `Nino · Invité ${slot} · testproj`, sceneName: `Nino · Invité ${slot} · testproj`,
    url: `http://127.0.0.1:4312/#guest-source/${String(slot).repeat(43)}` })),
});

test('both guest voices remain active through scoped scene changes without altering other productions', { timeout: 15_000 }, async () => {
  const fixture = await startFakeObs({ meters: false }); const obs = new RealObsGateway();
  try {
    await obs.connect(fixture.url, '');
    const options = guestOptions();
    await obs.prepareGuestSources(options);
    const snapshot = fixture.snapshot();
    assert.equal(snapshot.currentScene, 'Table ronde');
    assert.equal(snapshot.recording, false); assert.equal(snapshot.streaming, false);
    assert.equal(Object.keys(snapshot.inputs).length, 2);
    for (const guest of options.guests) {
      const source = snapshot.inputs[guest.inputName];
      assert.equal(source.kind, 'browser_source');
      assert.equal(source.muted, true, 'a waiting guest must not enter programme audio');
      assert.equal(source.monitorType, 'OBS_MONITORING_TYPE_NONE');
      assert.equal(source.settings.reroute_audio, true);
      assert.equal(source.settings.shutdown, false);
      assert.equal(source.settings.restart_when_active, false);
      assert.equal(source.settings.webpage_control_level, 0);
      assert.equal(source.settings.url, guest.url);
      for (const sceneName of [...options.sceneNames, ...options.guests.map(value => value.sceneName)]) {
        const matches = snapshot.sceneItems[sceneName].filter(item => item.sourceName === guest.inputName);
        assert.equal(matches.length, 1, 'one shared input per scene; never duplicate capture inputs');
        const item = matches[0];
        assert.equal(item.sceneItemEnabled, true, 'hidden guest still has programme audio');
        assert.equal(item.transform.positionX, sceneName === guest.sceneName ? 0 : 2020);
        assert.equal(item.transform.boundsWidth, 1920); assert.equal(item.transform.boundsHeight, 1080);
      }
    }
    assert.equal(snapshot.sceneItems.Podcast, undefined);
    assert.equal(snapshot.sceneItems.PowerPoint, undefined);
    assert.equal(snapshot.sceneItems['Caméra 2'], undefined);
    const state = obs.getState();
    for (const guest of options.guests) {
      assert.equal(state.inputs.find(input => input.name === guest.inputName)?.kind, 'browser_source');
      assert.equal(state.inputs.find(input => input.name === guest.inputName)?.muted, true);
    }
    await obs.setInputMute(options.guests[0].inputName, false);
    const updated = guestOptions(); updated.guests[0].url = `http://127.0.0.1:4312/#guest-source/${'N'.repeat(43)}`;
    await obs.prepareGuestSources(updated);
    assert.equal(fixture.snapshot().inputs[updated.guests[0].inputName].muted, false, 'preparation cannot silence an admitted guest');
    assert.equal(fixture.requests.filter(request => request.requestType === 'CreateInput').length, 2);
    assert.equal(fixture.requests.filter(request => request.requestType === 'CreateSceneItem').length, 8);
    assert.equal(fixture.snapshot().inputs[updated.guests[0].inputName].settings.url, updated.guests[0].url);
  } finally { await obs.disconnect(); await fixture.close(); }
});

test('guest source ownership and dedicated scene collisions are checked before any mutation', { timeout: 15_000 }, async () => {
  const fixture = await startFakeObs({ meters: false }); const obs = new RealObsGateway();
  try {
    await obs.connect(fixture.url, ''); const options = guestOptions();
    await obs.prepareGuestSources(options);
    const inputName = options.guests[1].inputName;
    const settings = fixture.snapshot().inputs[inputName].settings;
    for (const changes of [
      { kind: 'image_source' },
      { kind: 'browser_source', settings: { ...settings, nino_project: 'someone-else' } },
      { settings: { ...settings, url: 'https://example.com/#untrusted' } },
      { settings: { ...settings, reroute_audio: false } },
    ]) {
      fixture.changeInput(inputName, changes);
      const boundary = fixture.requests.length;
      await assert.rejects(obs.prepareGuestSources(options), /autre configuration/);
      assert.equal(fixture.requests.slice(boundary).some(request => /^(Set|Create)/.test(request.requestType)), false);
    }
    fixture.changeInput(inputName, { kind: 'browser_source', settings });
    fixture.addSceneItem(options.guests[0].sceneName, 'Micro 1');
    const boundary = fixture.requests.length;
    await assert.rejects(obs.prepareGuestSources(options), /source étrangère/);
    assert.equal(fixture.requests.slice(boundary).some(request => /^(Set|Create)/.test(request.requestType)), false);
  } finally { await obs.disconnect(); await fixture.close(); }
});

test('later guest controls require freshly verified source ownership and the corresponding scene item', { timeout: 15_000 }, async () => {
  const fixture = await startFakeObs({ meters: false }); const obs = new RealObsGateway();
  try {
    await obs.connect(fixture.url, ''); const options = guestOptions(); await obs.prepareGuestSources(options);
    const guest = options.guests[0]; const settings = fixture.snapshot().inputs[guest.inputName].settings;
    assert.equal(await obs.guestSourceOwned(guest.inputName, guest.id, options.projectId), true);
    assert.equal(await obs.guestSourceOwned(guest.inputName, 'different-guest', options.projectId), false);
    assert.equal(await obs.guestSourceOwned(guest.inputName, guest.id, 'another-project'), false);
    const boundary = fixture.requests.length;
    fixture.changeInput(guest.inputName, { kind: 'image_source' });
    assert.equal(await obs.guestSourceOwned(guest.inputName, guest.id, options.projectId), false);
    fixture.changeInput(guest.inputName, { kind: 'browser_source', settings: { ...settings, nino_scene: 'PowerPoint' } });
    assert.equal(await obs.guestSourceOwned(guest.inputName, guest.id, options.projectId), false);
    fixture.changeInput(guest.inputName, { settings }); fixture.addSceneItem(guest.sceneName, guest.inputName);
    assert.equal(await obs.guestSourceOwned(guest.inputName, guest.id, options.projectId), false);
    assert.equal(fixture.requests.slice(boundary).some(request => /^(Set|Create)/.test(request.requestType)), false, 'ownership checks must be read-only');
  } finally { await obs.disconnect(); await fixture.close(); }
});

test('provisioning guests one at a time preserves active sources and room audio without duplicating global microphones', { timeout: 15_000 }, async () => {
  const fixture = await startFakeObs({ meters: false, specialInputs: { mic1: 'Micro 1' } }); const obs = new RealObsGateway();
  try {
    await obs.connect(fixture.url, ''); const all = guestOptions();
    const first = { ...all, guests: [all.guests[0]], audioInputNames: ['Micro 1', 'Micro 2'] };
    await obs.prepareGuestSources(first);
    await obs.setInputMute(first.guests[0].inputName, false);
    const boundary = fixture.requests.length;
    const second = { ...all, guests: [all.guests[1]], audioInputNames: ['Micro 1', 'Micro 2'] };
    await obs.prepareGuestSources(second);
    assert.equal(fixture.requests.slice(boundary).some(request => request.requestType === 'SetInputSettings'), false, 'same URL/settings must not interrupt the active guest WebRTC page');
    const snapshot = fixture.snapshot();
    assert.equal(snapshot.inputs[first.guests[0].inputName].muted, false);
    assert.equal(snapshot.inputs[second.guests[0].inputName].muted, true);
    assert.equal(Object.keys(snapshot.inputs).length, 2);
    for (const guest of all.guests) {
      const items = snapshot.sceneItems[guest.sceneName];
      assert.equal(items.filter(item => item.sourceName === 'Micro 1').length, 0, 'OBS global microphone is already present in programme');
      const microphone = items.filter(item => item.sourceName === 'Micro 2');
      assert.equal(microphone.length, 1); assert.equal(microphone[0].sceneItemEnabled, true);
      assert.equal(microphone[0].transform.positionX, 2020);
      for (const other of all.guests) {
        const match = items.filter(item => item.sourceName === other.inputName);
        assert.equal(match.length, 1); assert.equal(match[0].sceneItemEnabled, true);
        assert.equal(match[0].transform.positionX, other.id === guest.id ? 0 : 2020);
      }
    }
    assert.equal(obs.getState().inputs.find(input => input.name === 'Micro 2')?.muted, false, 'only the scene item changes; room microphone input is untouched');
  } finally { await obs.disconnect(); await fixture.close(); }
});

test('existing empty user scenes and duplicate guest items are never silently claimed', { timeout: 15_000 }, async () => {
  for (const collision of ['empty', 'duplicate'] as const) {
    const fixture = await startFakeObs({ meters: false }); const obs = new RealObsGateway();
    try {
      const options = guestOptions();
      if (collision === 'empty') fixture.addScene(options.guests[0].sceneName);
      await obs.connect(fixture.url, '');
      if (collision === 'duplicate') {
        await obs.prepareGuestSources(options);
        fixture.addSceneItem('Caméra 1', options.guests[0].inputName);
      }
      const boundary = fixture.requests.length;
      await assert.rejects(obs.prepareGuestSources(options), collision === 'empty' ? /vide existe déjà/ : /plusieurs fois/);
      assert.equal(fixture.requests.slice(boundary).some(request => /^(Set|Create)/.test(request.requestType)), false);
    } finally { await obs.disconnect(); await fixture.close(); }
  }
});

test('browser source capability, loopback-only credentials and applied OBS state are required', { timeout: 15_000 }, async () => {
  for (const failure of ['unsupported', 'bad-url', 'mute', 'transform'] as const) {
    const fixture = await startFakeObs({ meters: false,
      ...(failure === 'unsupported' ? { inputKinds: ['image_source'] } : {}),
      ...(failure === 'mute' ? { ignoreMutations: ['SetInputMute'] } : {}),
      ...(failure === 'transform' ? { ignoreMutations: ['SetSceneItemTransform'] } : {}),
    });
    const obs = new RealObsGateway();
    try {
      await obs.connect(fixture.url, ''); const options = guestOptions();
      if (failure === 'bad-url') options.guests[0].url = `http://192.168.1.1:4312/#guest-source/${'x'.repeat(43)}`;
      await assert.rejects(obs.prepareGuestSources(options), failure === 'unsupported' ? /source Navigateur/ : failure === 'bad-url' ? /invalide/
        : failure === 'mute' ? /coupure du micro/ : /cadrage et le son/);
      if (failure === 'unsupported' || failure === 'bad-url') assert.equal(fixture.requests.some(request => /^(Set|Create)/.test(request.requestType)), false);
      if (failure === 'mute') {
        const snapshot = fixture.snapshot();
        assert.ok(snapshot.sceneItems[options.guests[0].sceneName].every(item => !item.sceneItemEnabled), 'an unconfirmed guest mic must never be activated');
      }
    } finally { await obs.disconnect(); await fixture.close(); }
  }
});

test('virtual camera is confirmed after asynchronous startup and does not change recording or live', { timeout: 15_000 }, async () => {
  const fixture = await startFakeObs({ meters: false, virtualCameraStartDelayMs: 450 }); const obs = new RealObsGateway();
  try {
    await obs.connect(fixture.url, '');
    await obs.startRecord(); await obs.startStream();
    await obs.startVirtualCamera(); await obs.startVirtualCamera();
    const snapshot = fixture.snapshot();
    assert.equal(snapshot.virtualCamera, true); assert.equal(snapshot.recording, true); assert.equal(snapshot.streaming, true);
    assert.equal(fixture.requests.filter(request => request.requestType === 'StartVirtualCam').length, 1);
    assert.equal(fixture.requests.some(request => ['StopRecord', 'StopStream', 'StopVirtualCam', 'SetCurrentProgramScene'].includes(request.requestType)), false);
  } finally { await obs.disconnect(); await fixture.close(); }
});

test('unavailable and unconfirmed virtual cameras report failure honestly', { timeout: 12_000 }, async () => {
  for (const failure of ['unsupported', 'unconfirmed'] as const) {
    const fixture = await startFakeObs({ meters: false, ...(failure === 'unsupported' ? { virtualCameraAvailable: false } : { ignoreMutations: ['StartVirtualCam'] }) });
    const obs = new RealObsGateway();
    try {
      await obs.connect(fixture.url, '');
      await assert.rejects(obs.startVirtualCamera(), failure === 'unsupported' ? /pas disponible/ : /pas confirmé/);
      assert.equal(fixture.snapshot().virtualCamera, false);
    } finally { await obs.disconnect(); await fixture.close(); }
  }
});
