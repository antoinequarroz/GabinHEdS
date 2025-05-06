// Gestion centralisée des profils régie auto
// Permet de charger, appliquer et lister les profils depuis des fichiers JSON

import profilTableRonde1 from '../../profil_table_ronde_1_intervenant.json'
import profilTableRonde2 from '../../profil_table_ronde_2_intervenants.json'
import profilPodcast from '../../profil_podcast.json'

import { obsClient } from '@/obs/ObsClient'
import { autocamClient } from '@/obs/AutocamClient'
// TODO: importer et brancher la gestion audio/overlays si besoin

export interface CameraProfile {
  name: string
  weight: number
}

export interface SceneProfile {
  name: string
  cameras: CameraProfile[]
  audio: {
    device: string
    threshold: number
  }
}

export interface RegieProfile {
  name: string
  scenes: SceneProfile[]
  recording: boolean
  overlays: string[]
  autostart: boolean
}

// Liste des profils disponibles (à étendre)
export const profiles: RegieProfile[] = [
  profilTableRonde1 as RegieProfile,
  profilTableRonde2 as RegieProfile,
  profilPodcast as RegieProfile
]

// Fonction pour obtenir le profil par nom
export function getProfileByName(name: string): RegieProfile | undefined {
  return profiles.find(p => p.name === name)
}

// Fonction pour appliquer un profil (branche ObsClient, etc.)
export async function applyProfile(profile: RegieProfile) {
  // 1. Appliquer la scène OBS (première scène du profil)
  if (profile.scenes && profile.scenes.length > 0) {
    await obsClient.setScene(profile.scenes[0].name)
  }
  // 2. Appliquer les pondérations caméras à l'autocam
  if (profile.scenes && profile.scenes.length > 0) {
    const cams = profile.scenes[0].cameras
    autocamClient.setCameraWeights(cams)
  }
  // 3. Régler l'audio (device, threshold)
  if (profile.scenes && profile.scenes.length > 0) {
    const audio = profile.scenes[0].audio
    autocamClient.setAudioDevice(audio.device, audio.threshold)
  }
  // 4. Overlays (à brancher selon ta logique)
  // 5. Recording/Autostart (à brancher selon ta logique)
  // Tu peux compléter ici selon tes besoins
}
