import { BehaviorSubject } from 'rxjs'
import { ObsServer } from '@/obs/ObsServer'
export class ObsClient {
    scenes$: BehaviorSubject<any[]>
    mainScene$: BehaviorSubject<string | undefined>
    recording$: BehaviorSubject<boolean>
    paused$: BehaviorSubject<boolean>
    obsConnected$: BehaviorSubject<boolean>
    activeScene$: BehaviorSubject<string | null>
    private obs: ObsServer

    constructor() {
        this.obs = new ObsServer()
        this.scenes$ = this.obs.scenes$
        this.mainScene$ = new BehaviorSubject<string | undefined>(undefined)
        this.recording$ = this.obs.recording$
        this.paused$ = this.obs.paused$
        this.obsConnected$ = this.obs.obsConnected$
        this.activeScene$ = this.obs.activeScene$
    }

    init() {
        // ...logique d'init, souscriptions, etc.
        this.scenes$.subscribe(scenes => {
            // ...mettre à jour la scène principale
        })
    }

    connect() {
        this.init()
        this.obs.connect()
    }

    sceneTransition(sceneName: string) {
        this.obs.sceneTransition(sceneName)
        this.mainScene$.next(sceneName)
    }

    setScene(sceneName: string) {
        this.obs.setScene(sceneName)
    }

    clean() {
        this.obs.clean()
        this.mainScene$.next(undefined)
    }

    startRecording() {
        this.obs.startRecording()
    }

    stopRecording() {
        this.obs.stopRecording()
    }

    pauseRecording() {
        this.obs.pauseRecording()
    }

    resumeRecording() {
        this.obs.resumeRecording()
    }

    /**
     * Passe automatiquement sur la scène "Table Ronde" dans OBS.
     * Optionnel : démarre l'enregistrement si demandé.
     */
    async setTableRondeScene({ startRecording = false } = {}) {
        await this.obs.setScene('Table Ronde')
        this.mainScene$.next('Table Ronde')
        if (startRecording) {
            await this.obs.startRecording()
        }
    }

    /**
     * Active ou désactive une caméra (source) dans la scène courante OBS.
     * @param sourceName Nom exact de la source OBS (caméra)
     * @param enabled true = visible, false = caché
     */
    async setCameraEnabled(sourceName: string, enabled: boolean) {
        await this.obs.setCameraEnabled(sourceName, enabled)
    }
}

// Singleton export explicite pour import { obsClient } from '@/obs/ObsClient'
export const obsClient = new ObsClient()
