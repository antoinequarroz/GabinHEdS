import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Marker, Project, SceneChange, Take } from '@gabin/shared';
import type { PlaybackFile } from './take-playback.js';
import { ApiFailure } from './validation.js';

export interface ResolveMediaInfo { frameRate: number; frames: number; durationMs: number; width: number; height: number; audioChannels: number; }
export interface ResolveTimeline { takeId: string; title: string; file: string; mediaFile: string; frameRate: number; frames: number; width: number; height: number; }
export interface ResolvePackage { timelines: ResolveTimeline[]; files: Map<string, Buffer>; }
const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const rate = (value: unknown): number => {
  if (typeof value !== 'string') return NaN;
  const [n, d = '1'] = value.split('/');
  const result = Number(n) / Number(d);
  return Number.isFinite(result) && result >= 1 && result <= 240 ? result : NaN;
};

/** Metadata only: compatibility encoding remains on the shared playback worker.
 * Probes are bounded and deduplicated; shutdown cancels every child process. */
export class ResolveProbe {
  private readonly jobs = new Map<string, Promise<ResolveMediaInfo>>();
  private readonly children = new Set<ChildProcess>();
  private active = 0;
  private closed = false;
  constructor(private readonly ffprobe = process.env.GABIN_FFPROBE_PATH ??
    (existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe')) {}
  async inspect(file: PlaybackFile): Promise<ResolveMediaInfo> {
    if (this.closed) throw new ApiFailure(503, 'L’export est momentanément indisponible.', 'RESOLVE_EXPORT_UNAVAILABLE');
    const key = JSON.stringify([file.file, file.fileStat.size, file.fileStat.mtimeMs, file.fileStat.ino, file.fileStat.dev]);
    const known = this.jobs.get(key);
    if (known) return known;
    if (this.active >= 2) throw new ApiFailure(429, 'Deux exports sont en cours de vérification. Réessayez dans quelques secondes.', 'RESOLVE_EXPORT_BUSY');
    while (this.jobs.size >= 128) this.jobs.delete(this.jobs.keys().next().value!);
    this.active++;
    const promise = this.probe(file.file).finally(() => { this.active--; });
    this.jobs.set(key, promise);
    promise.catch(() => this.jobs.delete(key));
    return promise;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const child of this.children) child.kill('SIGKILL');
    await Promise.allSettled(this.jobs.values());
    this.jobs.clear();
  }
  private async probe(file: string): Promise<ResolveMediaInfo> {
    const output = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(this.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'mov',
        '-show_entries', 'stream=codec_type,avg_frame_rate,r_frame_rate,nb_frames,duration,width,height,channels:format=duration',
        '-of', 'json', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.children.add(child);
      const chunks: Buffer[] = []; let bytes = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000); timer.unref();
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 128 * 1024) child.kill('SIGKILL'); else chunks.push(chunk); });
      // Never return probe diagnostics: filenames can contain private PC paths.
      child.stderr.resume();
      child.once('error', reject);
      child.once('close', code => { clearTimeout(timer); this.children.delete(child);
        if (code === 0 && bytes <= 128 * 1024 && !this.closed) resolve(Buffer.concat(chunks));
        else reject(new ApiFailure(422, 'Impossible de vérifier la cadence de cette prise pour DaVinci Resolve.', 'RESOLVE_MEDIA_INVALID')); });
    });
    const data = JSON.parse(output.toString()) as { streams?: Record<string, unknown>[]; format?: { duration?: string } };
    const video = data.streams?.find(stream => stream.codec_type === 'video');
    const audio = data.streams?.find(stream => stream.codec_type === 'audio');
    const frameRate = rate(video?.avg_frame_rate) || rate(video?.r_frame_rate);
    const duration = Number(video?.duration ?? data.format?.duration);
    const count = Number(video?.nb_frames);
    const frames = Number.isSafeInteger(count) && count > 0 ? count : Math.ceil(duration * frameRate);
    const width = Number(video?.width), height = Number(video?.height);
    if (!Number.isFinite(frameRate) || !Number.isSafeInteger(frames) || frames <= 0 || !Number.isFinite(duration) || duration <= 0
      || !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new ApiFailure(422, 'Cette prise ne possède pas de durée et de cadence vidéo valides.', 'RESOLVE_MEDIA_INVALID');
    }
    return { frameRate, frames, durationMs: duration * 1000, width, height, audioChannels: Number(audio?.channels) || 0 };
  }
}

const time = (value: number, fps: number) => ({ OTIO_SCHEMA: 'RationalTime.1', rate: fps, value });
const range = (start: number, duration: number, fps: number) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: time(start, fps), duration: time(duration, fps) });

/** A programme is already mixed by OBS. Keep it whole, with video and sound
 * linked; confirmed changes become navigation markers, never invented ISO cuts. */
export function resolveTimeline(take: Take, mediaFile: string, info: ResolveMediaInfo, markers: Marker[], changes: SceneChange[]): unknown {
  const position = (offset: number | null): number | null => offset !== null && Number.isFinite(offset) && offset >= 0 && offset < info.durationMs
    ? Math.min(info.frames - 1, Math.round(offset / 1000 * info.frameRate)) : null;
  const notes = new Map<number, { labels: string[]; notes: string[]; scene: boolean }>();
  const add = (offset: number | null, label: string, note: string, scene: boolean) => {
    const frame = position(offset); if (frame === null) return;
    const value = notes.get(frame) ?? { labels: [], notes: [], scene: false };
    value.labels.push(label); value.notes.push(note); value.scene ||= scene; notes.set(frame, value);
  };
  for (const marker of markers.filter(marker => marker.takeId === take.id)) add(marker.offsetMs, marker.label, `Repère Nino : ${marker.label}`, false);
  for (const change of changes.filter(change => change.takeId === take.id)) add(change.offsetMs, change.sceneName,
    `Scène OBS confirmée : ${change.sceneName}\nMotif : ${change.reason}${change.previousSceneName ? `\nDepuis : ${change.previousSceneName}` : ''}`, true);
  const timelineMarkers = [...notes].sort(([a], [b]) => a - b).map(([frame, value]) => ({ OTIO_SCHEMA: 'Marker.2',
    metadata: { Resolve_OTIO: { Keywords: [], Note: value.notes.join('\n\n') } }, name: value.labels.join(' · '),
    color: value.scene ? 'GREEN' : 'BLUE', marked_range: range(frame, 1, info.frameRate) }));
  const clip = (kind: 'Video' | 'Audio') => ({ OTIO_SCHEMA: 'Clip.2', metadata: { Resolve_OTIO: {
    'Link Group ID': 1, ...(kind === 'Audio' ? { Channels: Array.from({ length: info.audioChannels }, (_, index) => ({ 'Source Channel ID': index, 'Source Track ID': 0 })) } : {}) } },
    name: take.title, source_range: range(0, info.frames, info.frameRate), effects: [], markers: [], enabled: true,
    media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: 'ExternalReference.1', metadata: {}, name: take.title,
      available_range: range(0, info.frames, info.frameRate), available_image_bounds: null, target_url: mediaFile } }, active_media_reference_key: 'DEFAULT_MEDIA' });
  const track = (kind: 'Video' | 'Audio') => ({ OTIO_SCHEMA: 'Track.1', metadata: { Resolve_OTIO: { Locked: false,
    ...(kind === 'Audio' ? { 'Audio Type': info.audioChannels === 1 ? 'Mono' : 'Stereo', SoloOn: false } : {}) } }, name: kind === 'Video' ? 'Programme OBS' : 'Son OBS',
    source_range: null, effects: [], markers: [], enabled: true, children: [clip(kind)], kind });
  return { OTIO_SCHEMA: 'Timeline.1', metadata: { Resolve_OTIO: { 'Resolve OTIO Meta Version': '1.0' },
    Nino: { takeId: take.id, source: 'OBS programme complet', isolatedCameras: false, sceneChanges: 'markers_only', width: info.width, height: info.height } },
    name: take.title, global_start_time: time(0, info.frameRate), tracks: { OTIO_SCHEMA: 'Stack.1', metadata: {}, name: '',
      source_range: null, effects: [], markers: timelineMarkers, enabled: true, children: [track('Video'), ...(info.audioChannels ? [track('Audio')] : [])] } };
}

export function resolvePackage(project: Project, sources: { take: Take; mediaFile: string; timelineFile: string; info: ResolveMediaInfo }[], markers: Marker[], changes: SceneChange[]): ResolvePackage {
  const files = new Map<string, Buffer>();
  const timelines = sources.map(({ take, mediaFile, timelineFile, info }) => {
    files.set(timelineFile, json(resolveTimeline(take, mediaFile, info, markers, changes)));
    return { takeId: take.id, title: take.title, file: timelineFile, mediaFile, frameRate: info.frameRate, frames: info.frames, width: info.width, height: info.height };
  });
  files.set('resolve-project.json', json({ schemaVersion: 1, projectId: project.id, title: project.title, isolatedCameras: false, timelines }));
  files.set('IMPORTER_DANS_RESOLVE.txt', Buffer.from(resolveReadme));
  files.set('import-nino-resolve.py', Buffer.from(resolveImportScript));
  return { timelines, files };
}

export const resolveReadme = `NINO → DAVINCI RESOLVE\n\n1. Décompressez ce ZIP dans un dossier que vous garderez pour le montage.\n2. Dans DaVinci Resolve, créez un nouveau projet.\n3. Choisissez Fichier > Importer > Timeline et sélectionnez un fichier .otio de ce dossier.\n4. Cochez l’import des médias source. Si les médias sont demandés, indiquez le dossier resolve-media.\n5. Chaque prise possède sa timeline : vidéo entière + son. Les repères bleus sont vos notes ; les verts sont les scènes OBS confirmées.\n6. Répétez pour les autres prises. Les médias ajoutés sont dans media/ ; glissez ceux dont vous avez besoin dans la bibliothèque Resolve.\n\nL’enregistrement programme d’OBS contient déjà les changements de caméras. Ce paquet ne fournit pas de caméras isolées et ne recrée pas un multicam. Aucun silence, mot ou morceau de vidéo n’est supprimé.\nLes originaux inchangés sont dans takes/. resolve-media/ contient les MP4 compatibles préparés localement ; certains formats nécessitent une conversion vidéo (copie de lecture, pouvant être réduite à 1080p), les originaux restent la référence de qualité.\nLes changements sans timecode fiable (hors prise, pause) restent dans scene-changes.json et ne deviennent pas de faux repères. Les repères sont arrondis à l’image, à partir du timecode relevé lors de la confirmation OBS. Vérifiez visuellement le point exact du changement, notamment avec une cadence variable.\n\nOPTION POUR UNE PERSONNE TECHNIQUE\nLe script import-nino-resolve.py utilise l’API Python officielle de Resolve. Il crée toujours un NOUVEAU projet, importe chaque timeline et les médias compatibles, puis sauvegarde ce nouveau projet. Il ne modifie pas vos projets existants.\nActivez les scripts locaux dans les préférences Resolve si nécessaire et configurez DaVinciResolveScript selon le guide fourni avec Resolve. Exécutez :\n  python3 import-nino-resolve.py\nOu lancez le script depuis Resolve si Python est disponible. Le script doit rester à la racine du dossier décompressé.\nLes fichiers .otio conservent des chemins relatifs portables ; le script fabrique les chemins absolus uniquement sur l’ordinateur où vous importez.\n`;

export const resolveImportScript = `# Nino portable import. Python 3 + the official DaVinciResolveScript module.
# Creates a new project only; does not modify any existing project.
import json
import tempfile
from pathlib import Path
from datetime import datetime

def local_file(root, relative):
    value = Path(relative)
    if value.is_absolute() or '..' in value.parts or '\\\\' in relative:
        raise ValueError('Chemin de fichier invalide dans le paquet Nino.')
    result = (root / value).resolve(strict=True)
    if root not in result.parents or not result.is_file():
        raise ValueError('Fichier absent ou extérieur au dossier Nino.')
    return result

def import_nino(root, resolve_instance):
    root = Path(root).resolve(strict=True)
    config = json.loads((root / 'resolve-project.json').read_text(encoding='utf-8'))
    if config.get('schemaVersion') != 1 or not config.get('timelines'):
        raise ValueError('Paquet Nino invalide.')
    # Validate every path before creating a project.
    pairs = [(entry, local_file(root, entry['file']), local_file(root, entry['mediaFile'])) for entry in config['timelines']]
    pm = resolve_instance.GetProjectManager()
    base = 'Nino - ' + config['title'][:100] + ' - ' + datetime.now().strftime('%Y%m%d-%H%M%S')
    name = base
    existing = set(pm.GetProjectListInCurrentFolder())
    index = 2
    while name in existing:
        name = base + ' (' + str(index) + ')'
        index += 1
    project = pm.CreateProject(name)
    if not project:
        raise RuntimeError('Impossible de créer un nouveau projet Resolve.')
    media_pool = project.GetMediaPool()
    imported = []
    for entry, timeline_file, media_file in pairs:
        document = json.loads(timeline_file.read_text(encoding='utf-8'))
        for track in document['tracks']['children']:
            for clip in track['children']:
                clip['media_references']['DEFAULT_MEDIA']['target_url'] = str(media_file)
        # Do not rewrite the portable OTIO stored in the production folder.
        with tempfile.TemporaryDirectory(prefix='nino-resolve-') as temporary:
            temporary_file = Path(temporary) / timeline_file.name
            temporary_file.write_text(json.dumps(document, ensure_ascii=False), encoding='utf-8')
            timeline = media_pool.ImportTimelineFromFile(str(temporary_file), {'timelineName': entry['title'], 'importSourceClips': True, 'sourceClipsPath': str(media_file.parent)})
        if not timeline:
            raise RuntimeError('Import impossible : ' + entry['title'] + '. Les fichiers originaux sont conservés.')
        timeline.SetStartTimecode('00:00:00:00')
        imported.append(timeline.GetName())
    media_folder = root / 'media'
    if media_folder.is_dir():
        if root not in media_folder.resolve().parents:
            raise ValueError('Dossier de médias extérieur au paquet Nino.')
        assets = [str(local_file(root, item.relative_to(root).as_posix())) for item in media_folder.iterdir() if item.is_file() and item.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov', '.wav', '.mp3', '.m4a')]
        if assets:
            media_pool.ImportMedia(assets)
    if not pm.SaveProject():
        raise RuntimeError('Projet importé mais sauvegarde impossible. Sauvegardez manuellement dans Resolve.')
    return {'project': name, 'timelines': imported}

if __name__ == '__main__':
    import DaVinciResolveScript as dvr
    connection = dvr.scriptapp('Resolve')
    if not connection:
        raise RuntimeError('Ouvrez DaVinci Resolve et activez les scripts locaux avant cet import.')
    print(json.dumps(import_nino(Path(__file__).resolve().parent, connection), ensure_ascii=False))
`;
