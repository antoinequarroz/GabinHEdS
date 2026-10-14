import type { AudioFrame, AutoDirectionSettings, ObsState, Participant, SceneChange } from '@gabin/shared';

export const defaultAutoDirectionSettings = (wideScene: string): AutoDirectionSettings => ({ wideScene, thresholdDb: -38, dominanceDb: 6,
  confirmationMs: 600, minShotMs: 3000, silenceMs: 5000, overlapMs: 1000 });
export const AUDIO_STALE_MS = 1500;
export interface AutoDecision { sceneName: string; reason: Extract<SceneChange['reason'], 'speaker' | 'silence' | 'overlap'>; participantId: string | null; }
export interface AutoObservation { status: 'listening' | 'waiting'; message: string; participantId: string | null; audioAt: string | null; decision: AutoDecision | null; }

/** Local level detector, not transcription or voice identification. A shared mic
 * cannot tell two speakers apart. Only distinct, complete, fresh OBS meters can
 * produce a cut; one cached frame never confirms sustained speech. */
export class AutoDirection {
  private candidate: { key: string; since: number; decision: AutoDecision; hold: number } | null = null;
  private lastFrameAt: number | null = null;
  private lastShotAt: number;
  expectedScene: string | null;
  constructor(readonly participants: Participant[], readonly settings: AutoDirectionSettings, sceneName: string | null, now = Date.now()) {
    this.expectedScene = sceneName;
    this.lastShotAt = now;
  }
  confirmScene(sceneName: string | null, now = Date.now()): void {
    this.expectedScene = sceneName;
    this.lastShotAt = now;
    this.candidate = null;
  }
  reset(): void { this.candidate = null; this.lastFrameAt = null; }
  observe(frame: AudioFrame | null, obs: ObsState, now = Date.now()): AutoObservation {
    const wait = (message: string): AutoObservation => {
      this.reset();
      return { status: 'waiting', message, participantId: null, audioAt: null, decision: null };
    };
    if (!obs.connected || obs.error) return wait('OBS ne confirme plus le programme. Reconnectez puis reprenez l’automatique.');
    if (!obs.scenes.includes(this.settings.wideScene) || this.participants.some(p => !p.sceneName || !obs.scenes.includes(p.sceneName))) return wait('Un plan configuré n’est plus disponible dans OBS.');
    const blocked = this.participants.filter(p => !obs.inputs.some(input => input.name === p.micInput && input.muted === false));
    if (blocked.length) return wait(`Micro absent ou coupé : ${blocked.map(p => p.name).join(', ')}. Aucun changement automatique.`);
    const captured = frame ? Date.parse(frame.capturedAt) : NaN;
    if (!Number.isFinite(captured) || now - captured > AUDIO_STALE_MS || captured - now > 250) return wait('En attente de mesures OBS récentes sur chaque micro.');
    const levels = this.participants.map(person => ({ person, level: frame!.inputs.find(input => input.inputName === person.micInput) }));
    if (levels.some(({ level }) => !level || !Number.isFinite(level.rmsDb) || !Number.isFinite(level.peakDb)
      || level.rmsDb > 6 || level.rmsDb < -160 || level.peakDb > 6 || level.peakDb < -160 || level.rmsDb > level.peakDb + 1)) {
      return wait('Chaque micro doit fournir une mesure audio valide. Vérifiez les sources actives dans toutes les scènes OBS.');
    }
    // Out-of-order/repeated frames cannot advance a confirmation timer. Staleness
    // is still checked above on every watchdog tick.
    if (this.lastFrameAt !== null && captured <= this.lastFrameAt) return { status: 'listening', message: 'Écoute des micros OBS.', participantId: null, audioAt: frame!.capturedAt, decision: null };
    // A busy control queue may delay the watchdog. A fresh frame after a gap
    // cannot prove that speech continued while no measurements were observed.
    if (this.lastFrameAt !== null && captured - this.lastFrameAt > AUDIO_STALE_MS) this.candidate = null;
    this.lastFrameAt = captured;
    const speaking = levels.filter(({ level }) => level!.rmsDb >= this.settings.thresholdDb).sort((a, b) => b.level!.rmsDb - a.level!.rmsDb);
    let decision: AutoDecision;
    let hold: number;
    if (!speaking.length) {
      decision = { sceneName: this.settings.wideScene, reason: 'silence', participantId: null };
      hold = this.settings.silenceMs;
    } else if (speaking.length > 1 && speaking[0].level!.rmsDb - speaking[1].level!.rmsDb < this.settings.dominanceDb) {
      decision = { sceneName: this.settings.wideScene, reason: 'overlap', participantId: null };
      hold = this.settings.overlapMs;
    } else {
      decision = { sceneName: speaking[0].person.sceneName!, reason: 'speaker', participantId: speaking[0].person.id };
      hold = this.settings.confirmationMs;
    }
    const key = `${decision.reason}:${decision.participantId ?? ''}:${decision.sceneName}`;
    if (this.candidate?.key !== key) this.candidate = { key, since: captured, decision, hold };
    const confirmed = captured - this.candidate.since >= hold;
    const enoughShot = now - this.lastShotAt >= this.settings.minShotMs;
    const cut = confirmed && enoughShot && obs.currentScene !== decision.sceneName ? decision : null;
    return { status: 'listening', participantId: decision.participantId, audioAt: frame!.capturedAt, decision: cut,
      message: decision.reason === 'silence' ? 'Silence : maintien du plan, puis retour au plan large.' : decision.reason === 'overlap' ? 'Voix simultanées : préparation du plan large.' : `Voix détectée : ${speaking[0].person.name}.` };
  }
}
