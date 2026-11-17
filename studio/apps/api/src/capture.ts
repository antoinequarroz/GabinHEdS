import type { AudioFrame, CaptureCapability, CaptureInfo, CaptureSoftware, CaptureState, MediaKind, MediaMode, MediaPlayback, SceneThumbnail } from '@nino/shared';
import { captureSoftwareLabels } from '@nino/shared';

export type CaptureEvent =
  | { type: 'state'; state: CaptureState }
  | { type: 'recordStopped'; outputPath: string | null; durationMs: number }
  | { type: 'audio'; frame: AudioFrame }
  | { type: 'disconnected' };
export class CaptureFeedConflict extends Error {}
export class CaptureMediaFailure extends Error {}
export class CaptureGuestFailure extends Error {}
/** The capture software has no way to do this; nothing was sent. */
export class CaptureUnsupported extends Error {}
export interface CaptureMediaOptions { assetId: string; ownerId: string; kind: Exclude<MediaKind, 'document'>; file: string; mode: MediaMode; ownedFiles?: Record<string, string> }
export interface CaptureGuestSourceOptions {
  ownerId: string;
  projectId: string;
  /** Only the production's own plans; never all scenes of the capture software. */
  sceneNames: string[];
  /** Room microphones which are scene-local rather than global devices. */
  audioInputNames?: string[];
  guests: { id: string; slot: 1 | 2; name: string; sceneName: string; inputName: string; url: string }[];
}

/** One capture software (OBS, Streamlabs, Maya Studio) seen by the studio.
 * Real drivers and tests share this interface. No command assumes success:
 * every state change is confirmed by reading the software again. */
export interface CaptureDriver {
  /** Defaults to OBS for drivers written before the choice existed. */
  readonly software?: CaptureSoftware;
  /** Declared capabilities. When absent they are derived from the optional methods. */
  readonly capabilities?: readonly CaptureCapability[];
  getState(): CaptureState;
  connect(url: string, password: string): Promise<CaptureState>;
  disconnect(): Promise<void>;
  refresh(fresh?: boolean): Promise<CaptureState>;
  sceneThumbnail(sceneName: string): Promise<SceneThumbnail>;
  setScene(sceneName: string): Promise<void>;
  setInputMute(inputName: string, muted: boolean): Promise<void>;
  setRecordDirectory(directory: string): Promise<void>;
  startRecord(): Promise<void>;
  stopRecord(): Promise<{ outputPath: string | null }>;
  pauseRecord(): Promise<void>;
  resumeRecord(): Promise<void>;
  configureLocalFeed(settings: { server: string; key: string }): Promise<void>;
  startStream(): Promise<void>;
  stopStream(): Promise<void>;
  playMedia?(options: CaptureMediaOptions): Promise<MediaPlayback>;
  mediaAction?(action: 'pause' | 'resume' | 'stop'): Promise<MediaPlayback>;
  getMediaPlayback?(): MediaPlayback | null;
  prepareGuestSources?(options: CaptureGuestSourceOptions): Promise<void>;
  guestSourceOwned?(inputName: string, guestId: string, projectId: string): Promise<boolean>;
  startVirtualCamera?(): Promise<void>;
  subscribe(listener: (event: CaptureEvent) => void): () => void;
}

/** Everything OBS can do today; other drivers declare a subset. */
export const fullCaptureCapabilities: readonly CaptureCapability[] = ['record.pause', 'record.directory', 'audio.mute', 'audio.meters',
  'scene.thumbnails', 'stream.local', 'media.play', 'guests.browser'];

/** Public description of a driver, safe to send to every controller. */
export function captureInfo(driver: CaptureDriver): CaptureInfo {
  const software = driver.software ?? 'obs';
  const capabilities = driver.capabilities ? [...driver.capabilities] : fullCaptureCapabilities.filter(capability =>
    capability === 'media.play' ? Boolean(driver.playMedia && driver.mediaAction && driver.getMediaPlayback)
      : capability === 'guests.browser' ? Boolean(driver.prepareGuestSources && driver.guestSourceOwned && driver.startVirtualCamera)
        : true);
  return { software, label: captureSoftwareLabels[software], capabilities };
}

export function captureHas(driver: CaptureDriver, capability: CaptureCapability): boolean {
  return captureInfo(driver).capabilities.includes(capability);
}

export function emptyCaptureState(): CaptureState {
  return { connected: false, connecting: false, error: null, scenes: [], currentScene: null,
    inputs: [], recording: false, paused: false, timecode: '00:00:00.000', recordingDirectory: null, outputBytes: 0,
    streaming: false, streamReconnecting: false, streamTimecode: '00:00:00.000', streamOutputBytes: 0 };
}

export function timecodeMs(timecode: string): number {
  const match = /^(\d+):(\d+):(\d+)(?:\.(\d+))?$/.exec(timecode);
  if (!match) return 0;
  return (+match[1] * 3600 + +match[2] * 60 + +match[3]) * 1000 + +(match[4] ?? '0').padEnd(3, '0').slice(0, 3);
}
