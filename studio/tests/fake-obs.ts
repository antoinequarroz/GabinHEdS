import { copyFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

/** Generated solid-colour JPEG test fixture, never a camera or production image. */
const sceneFixtureImage = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAxAP/bAEMACAgICQgJCwsLCwsLDQwNDQ0NDQ0NDQ0NDQ0NDQ4ODhEREQ4ODg0NDg4QEBEREhMSERERERMTFBQUGBgXFxwcHSIiKf/EAEwAAQEAAAAAAAAAAAAAAAAAAAAHAQEBAAAAAAAAAAAAAAAAAAAABRABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIALQBQAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AJUAopgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//Z';

/** Protocol fixture only. Recording files are fake; optional stream hooks can publish test media. */
export interface FakeObsRequest {
  requestType: string;
  requestId: string;
  requestData: Record<string, unknown>;
}

export interface FakeStreamService {
  streamServiceType: string;
  streamServiceSettings: Record<string, unknown>;
}
export interface FakeObsMeterInput {
  inputName: string;
  inputUuid?: string;
  /** Per channel: [post-fader magnitude, post-fader peak, raw input peak]. */
  inputLevelsMul: number[][];
}
export interface FakeObsOptions {
  recordDirectory?: string;
  meters?: boolean;
  /** Output starts asynchronously after the successful command response. */
  recordStartDelayMs?: number;
  streamStartDelayMs?: number;
  onStreamStart?: (service: FakeStreamService) => Promise<void> | void;
  onStreamStop?: () => Promise<void> | void;
  /** A generated test media file to copy at StopRecord, never a real capture. */
  recordingFixture?: string;
  inputKinds?: string[];
  virtualCameraAvailable?: boolean;
  virtualCameraStartDelayMs?: number;
  specialInputs?: Record<string, string | null>;
  /** Simulate an OBS acknowledgement whose requested state was not applied. */
  ignoreMutations?: string[];
}

export async function startFakeObs(options: FakeObsOptions = {}) {
  const ownedDirectory = options.recordDirectory ? null : await mkdtemp(join(tmpdir(), 'gabin-fake-obs-'));
  let recordDirectory = options.recordDirectory ?? ownedDirectory!;
  let currentScene = 'Table ronde';
  let recording = false;
  let paused = false;
  let startTime = 0;
  let pausedAt = 0;
  let pauseDuration = 0;
  let sequence = 0;
  let outputPath: string | null = null;
  let streaming = false;
  let virtualCamera = false;
  let streamStartTime = 0;
  let streamService: FakeStreamService = { streamServiceType: 'rtmp_custom',
    streamServiceSettings: { server: 'rtmp://127.0.0.1:1935', key: 'fixture-initial-key' } };
  const requests: FakeObsRequest[] = [];
  const startTimers = new Set<ReturnType<typeof setTimeout>>();
  const delayedStart = (delay: number, start: () => void) => {
    const timer = setTimeout(() => { startTimers.delete(timer); start(); }, delay);
    startTimers.add(timer);
  };
  const identifications: number[] = [];
  const scenes = ['Podcast', 'Table ronde', 'PowerPoint', 'Plan large', 'Caméra 1', 'Caméra 2'];
  const mutes = new Map([['Micro 1', false], ['Micro 2', false], ['HDMI', false]]);
  const mediaInputs = new Map<string, { kind: string; settings: Record<string, unknown>; state: string }>();
  const monitors = new Map<string, string>();
  const transforms = new Map<number, Record<string, unknown>>();
  const sceneItems = new Map<string, { sceneItemId: number; sourceName: string; sceneItemEnabled: boolean }[]>();
  let nextItemId = 1;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const identified = new Map<WebSocket, number>();
  const send = (client: WebSocket, message: unknown) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  const event = (eventType: string, eventIntent: number, eventData: unknown) => {
    for (const [client, subscriptions] of identified) {
      if (subscriptions & eventIntent) send(client, { op: 5, d: { eventType, eventIntent, eventData } });
    }
  };
  const recordEvent = (outputState: string) => event('RecordStateChanged', 64, {
    outputActive: recording, outputState, outputPath: recording ? null : outputPath,
  });
  const streamEvent = (outputState: string) => event('StreamStateChanged', 64, { outputActive: streaming, outputState });
  const emitMeters = (inputs?: FakeObsMeterInput[]) => {
    const magnitude = 0.06 + Math.sin(Date.now() / 300) * 0.01;
    event('InputVolumeMeters', 1 << 16, { inputs: inputs ?? [...mutes].map(([inputName, muted], index) => ({
      inputName, inputUuid: `input-${index}`,
      inputLevelsMul: [[muted ? 0 : magnitude, muted ? 0 : magnitude * 2, magnitude * 2]],
    })) });
  };
  const meterTimer = options.meters === false ? null : setInterval(() => emitMeters(), 50);
  meterTimer?.unref();
  const elapsed = () => startTime ? Math.max(0, (paused ? pausedAt : Date.now()) - startTime - pauseDuration) : 0;
  const timecode = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const supported = ['GetVersion', 'GetSceneList', 'GetSourceScreenshot', 'GetCurrentProgramScene', 'GetInputList', 'GetInputMute',
    'GetInputVolume', 'SetInputMute', 'GetRecordStatus', 'GetRecordDirectory', 'SetRecordDirectory',
    'SetCurrentProgramScene', 'StartRecord', 'StopRecord', 'PauseRecord', 'ResumeRecord',
    'GetStreamStatus', 'StartStream', 'StopStream', 'GetStreamServiceSettings', 'SetStreamServiceSettings',
    'CreateScene', 'GetSceneItemList', 'CreateInput', 'CreateSceneItem', 'GetInputSettings', 'SetInputSettings',
    'SetSceneItemEnabled', 'GetSceneItemEnabled', 'GetVideoSettings', 'SetSceneItemTransform', 'TriggerMediaInputAction', 'GetMediaInputStatus'];
  supported.push('GetInputKindList', 'GetInputAudioMonitorType', 'SetInputAudioMonitorType', 'GetSceneItemTransform', 'GetVirtualCamStatus', 'StartVirtualCam');
  supported.push('GetSpecialInputs');

  server.on('connection', (client) => {
    send(client, { op: 0, d: { obsStudioVersion: 'test-fixture', obsWebSocketVersion: '5.6.0', rpcVersion: 1 } });
    client.on('close', () => identified.delete(client));
    client.on('message', (raw) => {
      // Serialize requests per connection, including asynchronous output creation.
      queue = queue.then(async () => {
        let message: { op: number; d?: Record<string, unknown> };
        try { message = JSON.parse(raw.toString()); } catch { client.close(4003, 'Invalid JSON'); return; }
        if (message.op === 1) {
          const subscriptions = typeof message.d?.eventSubscriptions === 'number' ? message.d.eventSubscriptions : 2047;
          identified.set(client, subscriptions);
          identifications.push(subscriptions);
          send(client, { op: 2, d: { negotiatedRpcVersion: 1 } });
          return;
        }
        if (!identified.has(client)) { client.close(4007, 'Not identified'); return; }
        if (message.op === 3 && typeof message.d?.eventSubscriptions === 'number') {
          identified.set(client, message.d.eventSubscriptions);
          return;
        }
        if (message.op !== 6 || !message.d) return;
        const request: FakeObsRequest = {
          requestType: String(message.d.requestType), requestId: String(message.d.requestId),
          requestData: (message.d.requestData ?? {}) as Record<string, unknown>,
        };
        requests.push(request);
        let responseData: Record<string, unknown> = {};
        let code = 100;
        let comment: string | undefined;
        const fail = (value: number, reason: string) => { code = value; comment = reason; };
        switch (request.requestType) {
          case 'GetVersion': responseData = { obsVersion: 'test-fixture', obsWebSocketVersion: '5.6.0', rpcVersion: 1,
            availableRequests: supported, supportedImageFormats: ['jpeg'], platform: 'test', platformDescription: 'Gabin protocol fixture' }; break;
          case 'GetSourceScreenshot':
            if (!scenes.includes(String(request.requestData.sourceName))) fail(600, 'Scene not found');
            else if (request.requestData.imageFormat !== 'jpeg') fail(400, 'The fixture supports JPEG only');
            else responseData = { imageData: sceneFixtureImage };
            break;
          case 'GetSceneList': responseData = { currentProgramSceneName: currentScene, currentPreviewSceneName: null,
            scenes: scenes.map((sceneName, sceneIndex) => ({ sceneName, sceneIndex, sceneUuid: `scene-${sceneIndex}` })) }; break;
          case 'GetCurrentProgramScene': responseData = { currentProgramSceneName: currentScene }; break;
          case 'GetInputList': responseData = { inputs: [...mutes.keys()].filter(name => !mediaInputs.has(name)).map((inputName, index) => ({
            inputName, inputUuid: `input-${index}`, inputKind: 'wasapi_input_capture', unversionedInputKind: 'wasapi_input_capture',
          })).concat([...mediaInputs].map(([inputName, input]) => ({ inputName, inputUuid: inputName, inputKind: input.kind, unversionedInputKind: input.kind }))) }; break;
          case 'GetInputKindList': responseData = { inputKinds: options.inputKinds ?? ['image_source', 'ffmpeg_source', 'browser_source', 'wasapi_input_capture'] }; break;
          case 'GetSpecialInputs': responseData = options.specialInputs ?? { desktop1: null, desktop2: null, mic1: null, mic2: null, mic3: null, mic4: null }; break;
          case 'CreateScene': {
            const sceneName = String(request.requestData.sceneName);
            if (scenes.includes(sceneName)) fail(601, 'Scene already exists');
            else { scenes.push(sceneName); sceneItems.set(sceneName, []); responseData = { sceneUuid: sceneName }; event('SceneListChanged', 4, { scenes }); }
            break;
          }
          case 'GetSceneItemList': {
            const sceneName = String(request.requestData.sceneName);
            if (!scenes.includes(sceneName)) fail(600, 'Scene not found');
            else responseData = { sceneItems: structuredClone(sceneItems.get(sceneName) ?? []) };
            break;
          }
          case 'CreateInput': {
            const name = String(request.requestData.inputName);
            const sceneName = String(request.requestData.sceneName);
            if (mediaInputs.has(name) || mutes.has(name)) fail(601, 'Input already exists');
            else if (!scenes.includes(sceneName)) fail(600, 'Scene not found');
            else {
              mediaInputs.set(name, { kind: String(request.requestData.inputKind), settings: structuredClone(request.requestData.inputSettings ?? {}) as Record<string, unknown>, state: 'OBS_MEDIA_STATE_STOPPED' });
              const items = sceneItems.get(sceneName) ?? []; const sceneItemId = nextItemId++;
              items.push({ sceneItemId, sourceName: name, sceneItemEnabled: !!request.requestData.sceneItemEnabled }); sceneItems.set(sceneName, items);
              responseData = { sceneItemId, inputUuid: name }; event('InputCreated', 8, { inputName: name, inputKind: request.requestData.inputKind });
            }
            break;
          }
          case 'CreateSceneItem': {
            const name = String(request.requestData.sourceName); const sceneName = String(request.requestData.sceneName);
            if ((!mediaInputs.has(name) && !mutes.has(name)) || !scenes.includes(sceneName)) fail(600, 'Source or scene missing');
            else {
              const items = sceneItems.get(sceneName) ?? []; const sceneItemId = nextItemId++;
              items.push({ sceneItemId, sourceName: name, sceneItemEnabled: !!request.requestData.sceneItemEnabled }); sceneItems.set(sceneName, items);
              responseData = { sceneItemId };
            }
            break;
          }
          case 'GetInputSettings': {
            const input = mediaInputs.get(String(request.requestData.inputName));
            if (!input) fail(600, 'Input not found'); else responseData = { inputKind: input.kind, inputSettings: structuredClone(input.settings) };
            break;
          }
          case 'SetInputSettings': {
            const input = mediaInputs.get(String(request.requestData.inputName));
            if (!input) fail(600, 'Input not found');
            else input.settings = request.requestData.overlay ? { ...input.settings, ...(request.requestData.inputSettings as Record<string, unknown>) } : structuredClone(request.requestData.inputSettings) as Record<string, unknown>;
            break;
          }
          case 'SetSceneItemEnabled': case 'GetSceneItemEnabled': {
            const item = (sceneItems.get(String(request.requestData.sceneName)) ?? []).find(item => item.sceneItemId === request.requestData.sceneItemId);
            if (!item) fail(600, 'Scene item missing');
            else if (request.requestType === 'GetSceneItemEnabled') responseData = { sceneItemEnabled: item.sceneItemEnabled };
            else item.sceneItemEnabled = !!request.requestData.sceneItemEnabled;
            break;
          }
          case 'SetSceneItemTransform': case 'GetSceneItemTransform': {
            if (!(sceneItems.get(String(request.requestData.sceneName)) ?? []).some(item => item.sceneItemId === request.requestData.sceneItemId)) fail(600, 'Scene item missing');
            else if (request.requestType === 'GetSceneItemTransform') responseData = { sceneItemTransform: structuredClone(transforms.get(Number(request.requestData.sceneItemId)) ?? {}) };
            else if (!options.ignoreMutations?.includes('SetSceneItemTransform')) transforms.set(Number(request.requestData.sceneItemId), structuredClone(request.requestData.sceneItemTransform as Record<string, unknown>));
            break;
          }
          case 'GetVideoSettings': responseData = { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 25, fpsDenominator: 1 }; break;
          case 'GetMediaInputStatus': {
            const input = mediaInputs.get(String(request.requestData.inputName));
            if (!input || input.kind !== 'ffmpeg_source') fail(600, 'Media input missing');
            else responseData = { mediaState: input.state, mediaDuration: 4000, mediaCursor: 0 };
            break;
          }
          case 'TriggerMediaInputAction': {
            const input = mediaInputs.get(String(request.requestData.inputName));
            if (!input || input.kind !== 'ffmpeg_source') fail(600, 'Media input missing');
            else switch (request.requestData.mediaAction) {
              case 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART': case 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY': input.state = 'OBS_MEDIA_STATE_PLAYING'; break;
              case 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE': input.state = 'OBS_MEDIA_STATE_PAUSED'; break;
              case 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP': input.state = 'OBS_MEDIA_STATE_STOPPED'; break;
              default: fail(400, 'Unknown media action');
            }
            break;
          }
          case 'GetInputMute':
            if (!mutes.has(String(request.requestData.inputName)) && !mediaInputs.has(String(request.requestData.inputName))) fail(600, 'Input not found');
            else responseData = { inputMuted: mutes.get(String(request.requestData.inputName)) ?? false };
            break;
          case 'GetInputAudioMonitorType': case 'SetInputAudioMonitorType': {
            const inputName = String(request.requestData.inputName);
            if (!mutes.has(inputName) && !mediaInputs.has(inputName)) fail(600, 'Input not found');
            else if (request.requestType === 'GetInputAudioMonitorType') responseData = { monitorType: monitors.get(inputName) ?? 'OBS_MONITORING_TYPE_NONE' };
            else monitors.set(inputName, String(request.requestData.monitorType));
            break;
          }
          case 'GetInputVolume': responseData = { inputVolumeDb: -6, inputVolumeMul: 0.501187 }; break;
          case 'GetStreamServiceSettings': responseData = structuredClone(streamService) as unknown as Record<string, unknown>; break;
          case 'SetStreamServiceSettings':
            if (streaming) fail(500, 'Streaming is active');
            else streamService = {
              streamServiceType: String(request.requestData.streamServiceType),
              streamServiceSettings: structuredClone(request.requestData.streamServiceSettings ?? {}) as Record<string, unknown>,
            };
            break;
          case 'GetStreamStatus': {
            const outputDuration = streaming ? Date.now() - streamStartTime : 0;
            responseData = { outputActive: streaming, outputReconnecting: false, outputTimecode: timecode(outputDuration),
              outputDuration, outputCongestion: 0, outputBytes: streaming ? outputDuration * 100 : 0,
              outputSkippedFrames: 0, outputTotalFrames: Math.floor(outputDuration / 40) };
            break;
          }
          case 'StartStream':
            if (streaming) fail(500, 'Already streaming');
            else {
              await options.onStreamStart?.(structuredClone(streamService));
              const start = () => {
                streaming = true;
                streamStartTime = Date.now();
                streamEvent('OBS_WEBSOCKET_OUTPUT_STARTED');
              };
              if (options.streamStartDelayMs) delayedStart(options.streamStartDelayMs, start);
              else start();
            }
            break;
          case 'StopStream':
            if (!streaming) fail(501, 'Not streaming');
            else {
              await options.onStreamStop?.();
              streaming = false;
              streamEvent('OBS_WEBSOCKET_OUTPUT_STOPPED');
            }
            break;
          case 'SetInputMute': {
            const inputName = String(request.requestData.inputName);
            if (!mutes.has(inputName) && !mediaInputs.has(inputName)) fail(600, 'Input not found');
            else {
              const inputMuted = Boolean(request.requestData.inputMuted);
              if (!options.ignoreMutations?.includes('SetInputMute')) mutes.set(inputName, inputMuted);
              event('InputMuteStateChanged', 8, { inputName, inputMuted });
            }
            break;
          }
          case 'GetVirtualCamStatus':
            if (options.virtualCameraAvailable === false) fail(204, 'Virtual camera unavailable');
            else responseData = { outputActive: virtualCamera };
            break;
          case 'StartVirtualCam':
            if (options.virtualCameraAvailable === false) fail(204, 'Virtual camera unavailable');
            else if (virtualCamera) fail(500, 'Already active');
            else if (!options.ignoreMutations?.includes('StartVirtualCam')) {
              if (options.virtualCameraStartDelayMs) delayedStart(options.virtualCameraStartDelayMs, () => { virtualCamera = true; });
              else virtualCamera = true;
            }
            break;
          case 'GetRecordStatus': responseData = { outputActive: recording, outputPaused: paused,
            outputTimecode: timecode(elapsed()), outputDuration: elapsed(), outputBytes: recording ? 4096 : 0 }; break;
          case 'GetRecordDirectory': responseData = { recordDirectory }; break;
          case 'SetRecordDirectory':
            if (recording) fail(500, 'Recording is active');
            else { recordDirectory = String(request.requestData.recordDirectory); await mkdir(recordDirectory, { recursive: true }); }
            break;
          case 'SetCurrentProgramScene': {
            const name = String(request.requestData.sceneName);
            if (!scenes.includes(name)) fail(600, 'Scene not found');
            else { currentScene = name; event('CurrentProgramSceneChanged', 4, { sceneName: name }); }
            break;
          }
          case 'StartRecord':
            if (recording) fail(500, 'Already recording');
            else {
              const start = () => {
                recording = true; paused = false; startTime = Date.now(); pauseDuration = 0; outputPath = null;
                recordEvent('OBS_WEBSOCKET_OUTPUT_STARTED');
              };
              if (options.recordStartDelayMs) delayedStart(options.recordStartDelayMs, start);
              else start();
            }
            break;
          case 'StopRecord':
            if (!recording) fail(501, 'Not recording');
            else {
              await mkdir(recordDirectory, { recursive: true });
              outputPath = join(recordDirectory, `test-recording-${++sequence}.mkv`);
              if (options.recordingFixture) await copyFile(options.recordingFixture, outputPath);
              else await writeFile(outputPath, 'TEST FIXTURE: not a playable media file\n');
              recording = false; paused = false; responseData = { outputPath };
              recordEvent('OBS_WEBSOCKET_OUTPUT_STOPPED');
            }
            break;
          case 'PauseRecord':
            if (!recording || paused) fail(501, 'Recording cannot pause');
            else { paused = true; pausedAt = Date.now(); recordEvent('OBS_WEBSOCKET_OUTPUT_PAUSED'); }
            break;
          case 'ResumeRecord':
            if (!recording || !paused) fail(501, 'Recording cannot resume');
            else { pauseDuration += Date.now() - pausedAt; paused = false; recordEvent('OBS_WEBSOCKET_OUTPUT_RESUMED'); }
            break;
          default: fail(204, `Unsupported test request: ${request.requestType}`);
        }
        send(client, { op: 7, d: { requestType: request.requestType, requestId: request.requestId,
          requestStatus: { result: code === 100, code, ...(comment ? { comment } : {}) }, responseData } });
      }).catch((error: Error) => client.close(1011, error.message.slice(0, 100)));
    });
    let queue = Promise.resolve();
  });
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('Missing fixture address');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    requests,
    identifications,
    emitMeters,
    snapshot() {
      return { currentScene, recording, streaming, virtualCamera, scenes: [...scenes],
        inputs: Object.fromEntries([...mediaInputs].map(([name, input]) => [name, { ...structuredClone(input),
          muted: mutes.get(name) ?? false, monitorType: monitors.get(name) ?? 'OBS_MONITORING_TYPE_NONE' }])),
        sceneItems: Object.fromEntries([...sceneItems].map(([name, items]) => [name, items.map(item => ({ ...item,
          transform: structuredClone(transforms.get(item.sceneItemId) ?? {}) }))])) };
    },
    changeInput(name: string, changes: { kind?: string; settings?: Record<string, unknown>; muted?: boolean }) {
      const input = mediaInputs.get(name);
      if (!input) throw new Error('Unknown fixture input');
      if (changes.kind !== undefined) input.kind = changes.kind;
      if (changes.settings !== undefined) input.settings = structuredClone(changes.settings);
      if (changes.muted !== undefined) mutes.set(name, changes.muted);
    },
    addScene(sceneName: string, sourceNames: string[] = []) {
      if (scenes.includes(sceneName)) throw new Error('Existing fixture scene');
      scenes.push(sceneName); sceneItems.set(sceneName, sourceNames.map(sourceName => ({ sceneItemId: nextItemId++, sourceName, sceneItemEnabled: true })));
    },
    addSceneItem(sceneName: string, sourceName: string) {
      if (!scenes.includes(sceneName)) throw new Error('Unknown fixture scene');
      const items = sceneItems.get(sceneName) ?? [];
      items.push({ sceneItemId: nextItemId++, sourceName, sceneItemEnabled: true }); sceneItems.set(sceneName, items);
    },
    finishMedia() {
      for (const [inputName, input] of mediaInputs) if (input.kind === 'ffmpeg_source' && input.state === 'OBS_MEDIA_STATE_PLAYING') {
        input.state = 'OBS_MEDIA_STATE_ENDED';
        event('MediaInputPlaybackEnded', 256, { inputName, inputUuid: inputName });
      }
    },
    disconnectClients() { for (const client of server.clients) client.terminate(); },
    async close() {
      if (meterTimer) clearInterval(meterTimer);
      for (const timer of startTimers) clearTimeout(timer);
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (streaming) await options.onStreamStop?.();
      if (ownedDirectory) await rm(ownedDirectory, { recursive: true, force: true });
    },
  };
}
