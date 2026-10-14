import path from 'node:path';
import type { ControlCommand, Participant, ProductionFormat, ProjectInput, RoomConfigInput } from '@gabin/shared';

export class ApiFailure extends Error {
  constructor(public statusCode: number, message: string, public code = 'INVALID_REQUEST') { super(message); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiFailure(400, 'Un objet JSON est requis.');
  return value as Record<string, unknown>;
}
export function string(value: unknown, field: string, max = 160, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new ApiFailure(400, `Champ « ${field} » invalide.`);
  return value.trim();
}
export function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new ApiFailure(400, `Champ « ${field} » invalide.`);
  return value as T;
}
export function optionalName(value: unknown, field: string): string | null {
  return value === null || value === '' ? null : string(value, field, 200);
}
const formats: ProductionFormat[] = ['podcast', 'roundtable', 'slides'];
export function projectInput(value: unknown, partial = false): Partial<ProjectInput> {
  const data = object(value);
  const result: Partial<ProjectInput> = {};
  const allowed = ['title', 'description', 'owner', 'format', 'participants', 'defaultScene', ...(partial ? ['status'] : [])];
  if (Object.keys(data).some((key) => !allowed.includes(key))) throw new ApiFailure(400, 'Champ de projet non reconnu.');
  if ('title' in data || !partial) result.title = string(data.title, 'nom de la vidéo', 160);
  if ('format' in data || !partial) result.format = choice(data.format, formats, 'format');
  if ('description' in data) result.description = string(data.description, 'description', 4000, true);
  if ('owner' in data) result.owner = string(data.owner, 'responsable', 160, true);
  if ('defaultScene' in data) result.defaultScene = optionalName(data.defaultScene, 'Scène affichée au démarrage');
  if ('participants' in data) {
    if (!Array.isArray(data.participants) || data.participants.length > 4) throw new ApiFailure(400, 'Un maximum de quatre participants présents est pris en charge.');
    result.participants = data.participants.map((value): Participant => {
      const participant = object(value);
      return { id: string(participant.id, 'identifiant du participant', 100), name: string(participant.name, 'nom du participant', 160),
        micInput: optionalName(participant.micInput, 'micro'), sceneName: optionalName(participant.sceneName, 'plan du participant') };
    });
    if (new Set(result.participants.map((person) => person.id)).size !== result.participants.length) throw new ApiFailure(400, 'Les identifiants des participants doivent être uniques.');
  }
  return result;
}
export function roomInput(value: unknown): RoomConfigInput {
  const data = object(value);
  const result: RoomConfigInput = {};
  if (Object.keys(data).some((key) => !['name', 'obsUrl', 'obsPassword', 'recordingRoot', 'defaultScenes', 'liveDestination'].includes(key))) throw new ApiFailure(400, 'Champ de salle non reconnu.');
  if ('name' in data) result.name = string(data.name, 'nom de la salle', 160);
  if ('obsPassword' in data) {
    if (typeof data.obsPassword !== 'string' || data.obsPassword.length > 512) throw new ApiFailure(400, 'Mot de passe OBS invalide.');
    result.obsPassword = data.obsPassword;
  }
  if ('obsUrl' in data) {
    result.obsUrl = string(data.obsUrl, 'adresse OBS', 1000);
    let url: URL;
    try { url = new URL(result.obsUrl); } catch { throw new ApiFailure(400, 'Adresse WebSocket OBS invalide.'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new ApiFailure(400, 'OBS doit se trouver sur ce PC : utilisez ws://127.0.0.1:4455.');
    }
  }
  if ('recordingRoot' in data) {
    result.recordingRoot = string(data.recordingRoot, 'dossier des vidéos', 2000);
    if (!path.isAbsolute(result.recordingRoot) || result.recordingRoot.includes('\0')) throw new ApiFailure(400, 'Le dossier des vidéos doit être un chemin absolu sur le PC.');
  }
  if ('defaultScenes' in data) {
    const scenes = object(data.defaultScenes);
    result.defaultScenes = { podcast: string(scenes.podcast, 'plan podcast', 200, true), roundtable: string(scenes.roundtable, 'plan table ronde', 200, true), slides: string(scenes.slides, 'plan présentation', 200, true) };
  }
  if ('liveDestination' in data) {
    const destination = object(data.liveDestination);
    const server = string(destination.server, 'serveur de diffusion', 2000, true);
    if (server) {
      let url: URL;
      try { url = new URL(server); } catch { throw new ApiFailure(400, 'Adresse RTMP de diffusion invalide.'); }
      if (!['rtmp:', 'rtmps:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash
        || ['0.0.0.0', '::', '[::]'].includes(url.hostname)) throw new ApiFailure(400, 'Utilisez une adresse de diffusion RTMP/RTMPS sans identifiants ni clé dans l’URL.');
    }
    result.liveDestination = { name: string(destination.name, 'nom de la destination', 160, true), server };
    if ('key' in destination) {
      if (typeof destination.key !== 'string' || destination.key.length > 2048 || /[\r\n\0]/.test(destination.key)) throw new ApiFailure(400, 'Clé de diffusion invalide.');
      result.liveDestination.key = destination.key;
    }
  }
  return result;
}
export function controlInput(value: unknown): ControlCommand {
  const data = object(value);
  const requestId = data.requestId === undefined ? undefined : string(data.requestId, 'identifiant de commande', 128);
  switch (data.action) {
    case 'record.start': case 'stream.start': return { action: data.action, projectId: string(data.projectId, 'projet', 100), requestId };
    case 'record.stop': case 'record.pause': case 'record.resume': return { action: data.action, requestId };
    case 'preview.start': case 'preview.stop': case 'stream.stop': return { action: data.action, requestId };
    case 'scene.set': return { action: data.action, sceneName: string(data.sceneName, 'plan', 200), requestId };
    case 'input.mute': {
      if (typeof data.muted !== 'boolean') throw new ApiFailure(400, 'L’état du micro doit être explicite.');
      return { action: data.action, inputName: string(data.inputName, 'micro', 200), muted: data.muted, requestId };
    }
    case 'marker.add': return { action: data.action, label: string(data.label, 'marqueur', 160), requestId };
    default: throw new ApiFailure(400, 'Commande non reconnue.');
  }
}
