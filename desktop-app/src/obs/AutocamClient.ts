import { reactive, ref } from 'vue'

/**
 * AutocamClient côté desktop-app :
 * - Permet de piloter la pondération (weight) de chaque caméra pour l'auto-régie
 * - Peut être relié à une API/backend pour synchroniser ces valeurs avec le backend (GabinOneclick)
 */

export class AutocamClient {
  // Liste des caméras/sources (adapter les noms à OBS)
  cameraSources: string[] = [
    'Caméra 1',
    'Caméra 2',
    'Caméra 3',
    // ...
  ]

  // Pondération (weight) de chaque caméra pour l'auto-switch (0-100)
  cameraWeights = ref<number[]>(this.cameraSources.map(() => 100 / this.cameraSources.length))

  // Méthode pour mettre à jour la pondération d'une caméra
  setCameraWeight(idx: number, val: number) {
    this.cameraWeights.value[idx] = val
    // TODO : envoyer la nouvelle pondération au backend (API, WebSocket, IPC...)
    // Exemple : this.sendWeightsToBackend()
  }

  /**
   * Applique un tableau de pondérations (depuis un profil ou autre)
   * cams = [{ name: string, weight: number }]
   */
  setCameraWeights(cams: { name: string, weight: number }[]) {
    this.cameraSources = cams.map(c => c.name)
    this.cameraWeights.value = cams.map(c => c.weight)
    // TODO : envoyer la config complète au backend/autocam
  }

  /**
   * Applique la config audio (depuis un profil)
   */
  setAudioDevice(device: string, threshold: number) {
    // TODO : envoyer la config audio au backend/autocam
    // Exemple : this.sendAudioConfigToBackend(device, threshold)
  }

  // (Optionnel) Méthode pour envoyer les pondérations au backend
  // sendWeightsToBackend() {
  //   // À implémenter selon la méthode de communication choisie
  // }
}

// Singleton exporté pour usage dans les vues
export const autocamClient = new AutocamClient()
