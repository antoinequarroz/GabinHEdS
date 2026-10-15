export type ProductionFormat = 'podcast' | 'roundtable' | 'slides';
export type DeviceRole = 'technician' | 'operator' | 'viewer';
export type DeviceKind = 'pc' | 'ipad' | 'streamdeck';

export interface Participant {
  id: string;
  name: string;
  micInput: string | null;
  sceneName: string | null;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  owner: string;
  format: ProductionFormat;
  participants: Participant[];
  defaultScene: string | null;
  status: 'draft' | 'ready' | 'recording' | 'completed' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  title: string;
  description?: string;
  owner?: string;
  format: ProductionFormat;
  participants?: Participant[];
  defaultScene?: string | null;
}

export interface RoomConfig {
  name: string;
  obsUrl: string;
  obsPasswordConfigured: boolean;
  recordingRoot: string;
  defaultScenes: Record<ProductionFormat, string>;
  liveDestination: LiveDestination;
}

export interface LiveDestination { name: string; server: string; keyConfigured: boolean; }
export interface LiveDestinationInput { name: string; server: string; key?: string; }

export interface RoomConfigInput {
  name?: string;
  obsUrl?: string;
  obsPassword?: string;
  recordingRoot?: string;
  defaultScenes?: Record<ProductionFormat, string>;
  liveDestination?: LiveDestinationInput;
}

export interface ObsInput {
  name: string;
  kind: string;
  muted: boolean | null;
  volumeDb: number | null;
}

export interface ObsState {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  scenes: string[];
  currentScene: string | null;
  inputs: ObsInput[];
  recording: boolean;
  paused: boolean;
  timecode: string;
  recordingDirectory: string | null;
  outputBytes: number;
  streaming: boolean;
  streamReconnecting: boolean;
  streamTimecode: string;
  streamOutputBytes: number;
}

export interface MediaState {
  available: boolean;
  previewReady: boolean;
  previewError: string | null;
  liveStatus: 'idle' | 'starting' | 'live' | 'stopping' | 'error';
  liveError: string | null;
  liveTimecode: string;
  liveBytes: number;
  liveDestination: string | null;
}

export interface AudioInputLevel { inputName: string; rmsDb: number; peakDb: number; }
export interface AudioFrame { capturedAt: string; inputs: AudioInputLevel[]; }
export interface PreviewSession { url: string; expiresAt: string; }

/** A recent OBS scene image. Unavailable never contains a last-known image. */
export interface SceneThumbnail {
  sceneName: string;
  imageData: string | null;
  capturedAt: string | null;
  available: boolean;
}

export interface Take {
  id: string;
  projectId: string;
  sequence: number;
  title: string;
  status: 'recording' | 'paused' | 'completed' | 'interrupted';
  startedAt: string;
  endedAt: string | null;
  outputPath: string | null;
  recordingDirectory: string;
  durationMs: number;
}

export interface Marker {
  id: string;
  takeId: string;
  label: string;
  offsetMs: number;
  createdAt: string;
}

/** Confirmed program cuts. Null offsets are observations outside usable recording time. */
export interface SceneChange {
  id: string;
  projectId: string;
  takeId: string | null;
  sceneName: string;
  previousSceneName: string | null;
  offsetMs: number | null;
  reason: 'manual' | 'speaker' | 'silence' | 'overlap' | 'media' | 'start';
  participantId: string | null;
  createdAt: string;
}

export interface AutoDirectionSettings {
  wideScene: string;
  thresholdDb: number;
  dominanceDb: number;
  confirmationMs: number;
  minShotMs: number;
  silenceMs: number;
  overlapMs: number;
}
export interface AutoDirectionState {
  enabled: boolean;
  status: 'off' | 'listening' | 'waiting' | 'suspended' | 'error';
  projectId: string | null;
  participantId: string | null;
  lastAudioAt: string | null;
  lastSwitchAt: string | null;
  message: string;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document';
export type MediaRole = 'intro' | 'logo' | 'presentation' | 'outro' | 'music' | 'other';
export interface MediaAsset {
  id: string;
  title: string;
  originalName: string;
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  archivedAt: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}
export interface ProjectMediaLink { assetId: string; role: MediaRole; order: number; }
export type MediaMode = 'fullscreen' | 'overlay' | 'audio';
export interface MediaPlayback {
  assetId: string;
  status: 'playing' | 'paused' | 'shown' | 'stopped' | 'unknown';
  mode: MediaMode;
  sceneName: string | null;
  error: string | null;
}
export interface FilePlaybackSession { url: string; expiresAt: string; mimeType: string; }
export interface TakePlaybackStatus {
  status: 'preparing' | 'ready' | 'failed';
  session?: FilePlaybackSession;
  error?: string;
}

export interface StudioState {
  revision: number;
  accessUrls?: string[];
  room: RoomConfig;
  obs: ObsState;
  media: MediaState;
  projects: Project[];
  takes: Take[];
  activeTake: Take | null;
  liveProjectId: string | null;
  markers: Marker[];
  library?: MediaAsset[];
  projectMedia?: Record<string, ProjectMediaLink[]>;
  mediaPlayback?: MediaPlayback | null;
  autoDirection?: AutoDirectionState;
  autoDirectionSettings?: Record<string, AutoDirectionSettings>;
  sceneChanges?: SceneChange[];
  guestRooms?: Record<string, GuestRoomState>;
}

export interface PreparationCheck {
  id: string;
  label: string;
  detail: string;
  status: 'ready' | 'warning' | 'blocked';
}

export interface Preparation {
  projectId: string;
  canStart: boolean;
  sceneName: string | null;
  recordingDirectory: string;
  freeBytes: number | null;
  checks: PreparationCheck[];
}

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  role: DeviceRole;
  createdAt: string;
  expiresAt: string | null;
}

export interface AuthResult {
  token: string;
  device: Device;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
  role: DeviceRole;
  kind: DeviceKind;
}

export interface DownloadTicket {
  url: string;
  expiresAt: string;
}
export interface ResolveExportStatus { status: 'preparing' | 'ready' | 'failed'; ticket?: DownloadTicket; error?: string; }
export interface TakeMp4DownloadStatus { status: 'preparing' | 'ready' | 'failed'; ticket?: DownloadTicket; error?: string; }

export interface GuestSlot {
  id: string; projectId: string; slot: 1 | 2; name: string;
  status: 'invited' | 'waiting' | 'ready' | 'admitted' | 'disconnected' | 'removed';
  joined: boolean; mediaReady: boolean; sourceReady: boolean; admitted: boolean; muted: boolean;
  sceneName: string; inputName: string; invitationExpiresAt: string | null; error: string | null;
}
export interface GuestRoomState {
  projectId: string;
  bridge: { connected: boolean; mediaReady: boolean; error: string | null };
  guests: GuestSlot[];
}
export interface GuestInvitation { guestId: string; slot: 1 | 2; url: string; expiresAt: string; }
export interface GuestIceServer { urls: string[]; username?: string; credential?: string; }
export type GuestPeerRole = 'guest' | 'bridge' | 'source';
export interface GuestPeer { id: string; role: GuestPeerRole; guestId: string | null; }
export interface GuestSession {
  token: string; role: GuestPeerRole; peerId: string; guestId: string | null; projectId: string;
  roomTitle: string; name: string; expiresAt: string; socketPath: string; iceServers: GuestIceServer[];
  room: GuestRoomState;
}
export type GuestClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'signal'; to: string; description?: { type: 'offer' | 'answer'; sdp: string }; candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null }
  | { type: 'media'; ready: boolean; guestId?: string; video?: boolean; audio?: boolean; error?: string }
  | { type: 'leave' };
export type GuestServerMessage =
  | { type: 'welcome'; peer: GuestPeer; peers: GuestPeer[]; room: GuestRoomState }
  | { type: 'room'; peers: GuestPeer[]; room: GuestRoomState }
  | { type: 'signal'; from: GuestPeer; description?: { type: 'offer' | 'answer'; sdp: string }; candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null }
  | { type: 'error'; error: string };

export type ControlCommand =
  | { action: 'guest.admit'; guestId: string; requestId?: string }
  | { action: 'guest.mute'; guestId: string; muted: boolean; requestId?: string }
  | { action: 'guest.remove'; guestId: string; requestId?: string }
  | { action: 'guest.scene'; guestId: string; requestId?: string }
  | { action: 'guest.prepare'; projectId: string; requestId?: string }
  | { action: 'guest.bridge.stop'; projectId: string; requestId?: string }
  | { action: 'auto.configure'; projectId: string; settings: AutoDirectionSettings; requestId?: string }
  | { action: 'auto.start'; projectId: string; requestId?: string }
  | { action: 'auto.stop'; requestId?: string }
  | { action: 'record.start'; projectId: string; requestId?: string }
  | { action: 'record.stop' | 'record.pause' | 'record.resume'; requestId?: string }
  | { action: 'scene.set'; sceneName: string; requestId?: string }
  | { action: 'input.mute'; inputName: string; muted: boolean; requestId?: string }
  | { action: 'marker.add'; label: string; requestId?: string }
  | { action: 'preview.start' | 'preview.stop' | 'stream.stop'; requestId?: string }
  | { action: 'stream.start'; projectId: string; requestId?: string }
  | { action: 'media.play'; assetId: string; projectId?: string; mode?: MediaMode; requestId?: string }
  | { action: 'media.pause' | 'media.resume' | 'media.stop'; requestId?: string };

export interface ApiError { error: string; code?: string; }

export type ClientMessage = { type: 'auth'; token: string };
export type ServerMessage =
  | { type: 'state'; state: StudioState }
  | { type: 'audio'; frame: AudioFrame }
  | { type: 'error'; error: string };

export const formatLabels: Record<ProductionFormat, string> = {
  podcast: 'Podcast',
  roundtable: 'Table ronde',
  slides: 'PowerPoint sonorisé',
};
