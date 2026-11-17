import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

/** Generated 1x1 JPEG-shaped data URL for screenshots, never a real capture. */
const screenshot = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

export interface FakeMayaRequest { type: string; data: Record<string, unknown> }

/** Protocol fixture for the Suite Media protocol v1 as Maya Studio's studiod
 * speaks it (maya-studio/docs/protocole-suite.md). Outputs are simulated:
 * StopRecording writes a small placeholder file at the requested path. */
export async function startFakeMaya(options: { token?: string; scenes?: string[] } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const scenes = (options.scenes ?? ['Plateau', 'Caméra 1', 'Caméra 2']).map(name => ({ id: randomUUID(), name }));
  let program = scenes[0]!.id;
  const outputs: Record<'record' | 'stream', { target: string; startedAt: number } | null> = { record: null, stream: null };
  const requests: FakeMayaRequest[] = [];
  const clients = new Set<WebSocket>();
  const broadcast = (type: string, data: Record<string, unknown>) => {
    for (const client of clients) client.send(JSON.stringify({ op: 'event', app: 'studio', type, data }));
  };
  const status = (kind: 'record' | 'stream') => {
    const output = outputs[kind];
    return output ? { active: true, target: output.target, frames: 0, duration_s: (Date.now() - output.startedAt) / 1000 } : { active: false };
  };
  const find = (key: unknown) => scenes.find(scene => scene.id === key || scene.name === key);

  server.on('connection', (socket) => {
    let identified = false;
    socket.send(JSON.stringify({ op: 'hello', app: { id: 'studio', name: 'Maya Studio', version: '0.1.0' }, protocol: 1,
      auth_required: Boolean(options.token), capabilities: ['core', 'studio.scenes', 'studio.sources', 'studio.outputs', 'studio.preview'] }));
    socket.on('message', async (raw) => {
      const message = JSON.parse(String(raw)) as { op: string; id?: string; type?: string; data?: Record<string, unknown>; token?: string; events?: boolean };
      if (message.op === 'identify') {
        if (options.token && message.token !== options.token) {
          socket.send(JSON.stringify({ op: 'response', id: '', ok: false, error: { code: 'auth_failed', message: 'jeton invalide' } }));
          socket.close(); return;
        }
        identified = true;
        if (message.events) clients.add(socket);
        socket.send(JSON.stringify({ op: 'identified', client_id: '1' }));
        return;
      }
      const id = message.id ?? '';
      const ok = (data: unknown) => socket.send(JSON.stringify({ op: 'response', id, ok: true, data }));
      const err = (code: string, text: string) => socket.send(JSON.stringify({ op: 'response', id, ok: false, error: { code, message: text } }));
      if (!identified) return err('not_identified', 'envoie d’abord « identify »');
      const data = message.data ?? {};
      requests.push({ type: message.type ?? '', data });
      switch (message.type) {
        case 'GetSceneList': return ok({ scenes: scenes.map(scene => ({ id: scene.id, name: scene.name, sources: 0 })), program_scene: program, preview_scene: program });
        case 'GetOutputStatus': return ok({ record: status('record'), stream: status('stream') });
        case 'SetProgramScene': {
          const scene = find(data.scene);
          if (!scene) return err('scene_not_found', `scène introuvable : ${String(data.scene)}`);
          program = scene.id; broadcast('ProgramSceneChanged', { scene_id: scene.id }); return ok({ scene_id: scene.id });
        }
        case 'GetScreenshot': return find(data.scene ?? program) ? ok({ image: screenshot }) : err('screenshot_failed', 'scène introuvable');
        case 'StartRecording': case 'StartStream': {
          const kind = message.type === 'StartRecording' ? 'record' : 'stream';
          if (outputs[kind]) return err('output_already_active', 'cette sortie est déjà active');
          const target = typeof (kind === 'record' ? data.path : data.url) === 'string' ? String(kind === 'record' ? data.path : data.url) : '';
          if (!target) return err('missing_url', 'URL de diffusion manquante');
          outputs[kind] = { target, startedAt: Date.now() };
          broadcast('OutputStarted', { output: kind, target });
          return ok({ output: kind, target });
        }
        case 'StopRecording': case 'StopStream': {
          const kind = message.type === 'StopRecording' ? 'record' : 'stream';
          const output = outputs[kind];
          if (!output) return err('output_not_active', 'cette sortie n’est pas active');
          outputs[kind] = null;
          if (kind === 'record') await writeFile(output.target, 'fake maya recording');
          const result = { output: kind, target: output.target, frames: 0, duration_s: (Date.now() - output.startedAt) / 1000 };
          broadcast('OutputStopped', result);
          return ok(result);
        }
        default: return err('unknown_request', `requête inconnue : ${String(message.type)}`);
      }
    });
    socket.on('close', () => clients.delete(socket));
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    requests,
    outputs,
    programName: () => scenes.find(scene => scene.id === program)?.name ?? null,
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
