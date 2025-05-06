// gabinApi.js
// API front-end pour communiquer avec le backend Gabin (multi-cam, scènes...)
// À adapter selon le vrai protocole Gabin (WebSocket, HTTP fetch, etc.)

// Version démo/mock avec promesses

export async function switchSceneOnGabin(sceneName) {
  // TODO : remplacer par un vrai appel à Gabin (WebSocket, HTTP...)
  console.log('[Gabin] Switch scene to', sceneName)
  // Simule un délai réseau
  return new Promise(resolve => setTimeout(() => resolve({ success: true, scene: sceneName }), 400))
}

export async function getCurrentSceneFromGabin() {
  // TODO : remplacer par un vrai appel à Gabin
  // Simule une scène courante
  return new Promise(resolve => setTimeout(() => resolve('Program'), 200))
}
