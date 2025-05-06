import ObsWebSocket from 'obs-websocket-js'
import type { OBSResponseTypes } from 'obs-websocket-js'
import { BehaviorSubject } from 'rxjs'
import deepEqual from 'deep-eql'

// ...autres imports utilitaires et types nécessaires

export class ObsServer {
    websocket: ObsWebSocket
    scenes$: BehaviorSubject<any[]>
    initScene: string = ''
    recording$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false)
    paused$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false)
    obsConnected$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false)
    activeScene$: BehaviorSubject<string | null> = new BehaviorSubject<string | null>(null)
    // ...autres propriétés nécessaires

    constructor() {
        this.websocket = new ObsWebSocket()
        this.scenes$ = new BehaviorSubject<any[]>([])
        this.recording$ = new BehaviorSubject<boolean>(false)
        this.paused$ = new BehaviorSubject<boolean>(false)
        this.obsConnected$ = new BehaviorSubject<boolean>(false)
        this.activeScene$ = new BehaviorSubject<string | null>(null)
        // ...init autres propriétés
    }

    async connect(connection?: any) {
        try {
            // ...logique de connexion à OBS
            await this.websocket.connect(/* ... */)
            this.obsConnected$.next(true)
            // Récupère les scènes dès la connexion
            const scenesData = await this.websocket.call('GetSceneList')
            this.scenes$.next(scenesData.scenes)
            this.activeScene$.next(scenesData.currentProgramSceneName)
            // Ecoute le changement de scène
            this.websocket.on('CurrentProgramSceneChanged', (data: any) => {
                this.activeScene$.next(data.sceneName)
            })
            // ...gestion des événements, des scènes, etc.
            this.websocket.on('RecordStateChanged', (data: any) => {
                this.recording$.next(data.outputActive)
                this.paused$.next(data.outputPaused)
            })
        } catch (e) {
            this.obsConnected$.next(false)
            console.error('Erreur connexion OBS:', e)
        }
    }

    async startRecording() {
        try {
            await this.websocket.call('StartRecord')
        } catch (e) {
            console.error('Erreur startRecording OBS:', e)
        }
    }

    async stopRecording() {
        try {
            await this.websocket.call('StopRecord')
        } catch (e) {
            console.error('Erreur stopRecording OBS:', e)
        }
    }

    async pauseRecording() {
        try {
            await this.websocket.call('PauseRecord')
        } catch (e) {
            console.error('Erreur pauseRecording OBS:', e)
        }
    }

    async resumeRecording() {
        try {
            await this.websocket.call('ResumeRecord')
        } catch (e) {
            console.error('Erreur resumeRecording OBS:', e)
        }
    }

    async setScene(sceneName: string) {
        try {
            await this.websocket.call('SetCurrentProgramScene', { sceneName })
        } catch (e) {
            console.error('Erreur setScene OBS:', e)
        }
    }

    sceneTransition(sceneName: string) {
        try {
            // ...logique pour changer de scène
            this.websocket.call('SetCurrentProgramScene', { sceneName })
        } catch (e) {
            console.error('Erreur sceneTransition OBS:', e)
        }
    }

    /**
     * Active ou désactive une source (caméra) dans la scène courante.
     * @param sourceName Nom exact de la source OBS (caméra)
     * @param enabled true = visible, false = caché
     */
    async setCameraEnabled(sourceName: string, enabled: boolean) {
        try {
            // Récupère la scène courante
            const { currentProgramSceneName } = await this.websocket.call('GetCurrentProgramScene')
            // Récupère tous les items de la scène
            const { sceneItems } = await this.websocket.call('GetSceneItemList', { sceneName: currentProgramSceneName })
            // Trouve l'item correspondant à la source
            const item = sceneItems.find((i: any) => i.sourceName === sourceName)
            if (!item) throw new Error('Source non trouvée: ' + sourceName)
            // Active/désactive la source
            await this.websocket.call('SetSceneItemEnabled', {
                sceneName: currentProgramSceneName,
                sceneItemId: item.sceneItemId,
                sceneItemEnabled: enabled
            })
        } catch (e) {
            console.error('Erreur setCameraEnabled OBS:', e)
        }
    }

    clean() {
        try {
            // ...nettoyage, déconnexion, etc.
            this.websocket.disconnect()
        } catch (e) {
            console.error('Erreur clean OBS:', e)
        }
    }
}
