import { ObsClient } from './ObsClient'

// Singleton pour l'accès global OBS dans l'app
export const obsClient = new ObsClient()

// Exemple d'utilisation dans desktop-app
// obsClient.connect()
// obsClient.sceneTransition('NomDeLaScene')
// obsClient.mainScene$.subscribe(scene => { /* ...mettre à jour l'UI... */ })
