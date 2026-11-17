import path from 'node:path';
import type { AutoDirectionSettings, ControlCommand, MediaMode, Participant, ProductionFormat, ProjectInput, ProjectMediaLink, RoomConfigInput } from '@nino/shared';

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
/** A profile becomes an ordinary room update, validated by the same rules. */
export function studioProfileInput(value: unknown): RoomConfigInput {
  const data = object(value);
  if (data.kind !== 'nino.studio-profile') throw new ApiFailure(400, 'Ce fichier n’est pas une configuration de studio Nino.', 'PROFILE_INVALID');
  if (data.version !== 1) throw new ApiFailure(400, 'Cette configuration vient d’une version de Nino plus récente.', 'PROFILE_VERSION');
  const room = object(data.room);
  const destination = object(room.liveDestination);
  return roomInput({ name: room.name, captureSoftware: room.captureSoftware, obsUrl: room.captureUrl, recordingRoot: room.recordingRoot,
    defaultScenes: room.defaultScenes, liveDestination: { name: destination.name, server: destination.server } });
}
export function roomInput(value: unknown): RoomConfigInput {
  const data = object(value);
  const result: RoomConfigInput = {};
  if (Object.keys(data).some((key) => !['name', 'captureSoftware', 'obsUrl', 'obsPassword', 'recordingRoot', 'defaultScenes', 'liveDestination'].includes(key))) throw new ApiFailure(400, 'Champ de salle non reconnu.');
  if ('name' in data) result.name = string(data.name, 'nom de la salle', 160);
  if ('captureSoftware' in data) result.captureSoftware = choice(data.captureSoftware, ['obs', 'streamlabs', 'maya'] as const, 'logiciel de captation');
  if ('obsPassword' in data) {
    if (typeof data.obsPassword !== 'string' || data.obsPassword.length > 512) throw new ApiFailure(400, 'Mot de passe du logiciel de captation invalide.');
    result.obsPassword = data.obsPassword;
  }
  if ('obsUrl' in data) {
    result.obsUrl = string(data.obsUrl, 'adresse du logiciel de captation', 1000);
    let url: URL;
    try { url = new URL(result.obsUrl); } catch { throw new ApiFailure(400, 'Adresse WebSocket du logiciel de captation invalide.'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new ApiFailure(400, 'Le logiciel de captation doit se trouver sur ce PC : utilisez une adresse ws://127.0.0.1:<port>.');
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
    case 'studio.open': {
      if (Object.keys(data).some(key => !['action', 'requestId'].includes(key))) throw new ApiFailure(400, 'L’ouverture du studio n’accepte aucun argument.');
      return { action: data.action, requestId };
    }
    case 'production.start': {
      if (data.includeLive !== undefined && typeof data.includeLive !== 'boolean') throw new ApiFailure(400, 'Le choix de diffuser en direct doit être explicite.');
      return { action: data.action, projectId: string(data.projectId, 'projet', 100), includeLive: data.includeLive ?? false, requestId };
    }
    case 'production.cancel': return { action: data.action, requestId };
    case 'guest.prepare': case 'guest.bridge.stop': return { action: data.action, projectId: string(data.projectId, 'projet', 100), requestId };
    case 'guest.admit': case 'guest.remove': case 'guest.scene': return { action: data.action, guestId: string(data.guestId, 'invité', 100), requestId };
    case 'guest.mute': {
      if (typeof data.muted !== 'boolean') throw new ApiFailure(400, 'L’état du micro doit être explicite.');
      return { action: data.action, guestId: string(data.guestId, 'invité', 100), muted: data.muted, requestId };
    }
    case 'auto.configure': return { action: data.action, projectId: string(data.projectId, 'projet', 100), settings: autoDirectionInput(data.settings), requestId };
    case 'auto.start': return { action: data.action, projectId: string(data.projectId, 'projet', 100), requestId };
    case 'auto.stop': return { action: data.action, requestId };
    case 'media.play': return { action: data.action, assetId: string(data.assetId, 'média', 100),
      projectId: data.projectId === undefined ? undefined : string(data.projectId, 'projet', 100),
      mode: data.mode === undefined ? undefined : choice<MediaMode>(data.mode, ['fullscreen', 'overlay', 'audio'], 'mode du média'), requestId };
    case 'media.pause': case 'media.resume': case 'media.stop': return { action: data.action, requestId };
    case 'record.start': case 'stream.start': return { action: data.action, projectId: string(data.projectId, 'projet', 100), requestId };
    case 'record.stop': return { action: data.action, requestId,
      ...(data.expectedTakeId === undefined ? {} : { expectedTakeId: string(data.expectedTakeId, 'identifiant de prise', 100) }) };
    case 'record.pause': case 'record.resume': return { action: data.action, requestId };
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

export function autoDirectionInput(value: unknown): AutoDirectionSettings {
  const data = object(value);
  const fields = ['wideScene', 'thresholdDb', 'dominanceDb', 'confirmationMs', 'minShotMs', 'silenceMs', 'overlapMs'];
  if (Object.keys(data).some(key => !fields.includes(key))) throw new ApiFailure(400, 'Réglage automatique non reconnu.');
  const bounded = (name: string, min: number, max: number): number => {
    const n = data[name];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || !Number.isInteger(n)) throw new ApiFailure(400, `Réglage « ${name} » : un entier de ${min} à ${max} est requis.`);
    return n;
  };
  return { wideScene: string(data.wideScene, 'plan large', 200), thresholdDb: bounded('thresholdDb', -60, -10), dominanceDb: bounded('dominanceDb', 3, 20),
    confirmationMs: bounded('confirmationMs', 300, 3000), minShotMs: bounded('minShotMs', 1000, 15000), silenceMs: bounded('silenceMs', 1500, 15000), overlapMs: bounded('overlapMs', 300, 5000) };
}

export function projectMediaInput(value: unknown): ProjectMediaLink[] {
  const data = object(value);
  if (Object.keys(data).some(key => key !== 'links') || !Array.isArray(data.links) || data.links.length > 100) throw new ApiFailure(400, 'La liste des médias du projet est invalide.');
  const links = data.links.map(item => {
    const link = object(item);
    if (Object.keys(link).some(key => !['assetId', 'role', 'order'].includes(key)) || !Number.isInteger(link.order) || Number(link.order) < 0 || Number(link.order) > 9999) throw new ApiFailure(400, 'L’ordre du média doit être un entier entre 0 et 9999.');
    return { assetId: string(link.assetId, 'média', 100), role: choice(link.role, ['intro', 'logo', 'presentation', 'outro', 'music', 'other'] as const, 'rôle du média'), order: Number(link.order) };
  });
  if (new Set(links.map(link => link.assetId)).size !== links.length) throw new ApiFailure(400, 'Chaque média ne peut être associé qu’une fois au projet.');
  return links.sort((a, b) => a.order - b.order);
}
