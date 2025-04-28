// obsControl.js
// Contrôle OBS via WebSocket pour démarrer/arrêter/enregistrer depuis l'UI Gabin

const OBSWebSocket = require('obs-websocket-js').default;
const obs = new OBSWebSocket();
const fs = require('fs');
const path = require('path');

async function connectOBS() {
  if (obs.connected) return;
  await obs.connect('ws://127.0.0.1:4455'); // Port par défaut OBS WebSocket 5.x
}

async function startRecording() {
  await connectOBS();
  await obs.call('StartRecord');
}

async function stopRecording() {
  await connectOBS();
  await obs.call('StopRecord');
}

async function pauseRecording() {
  await connectOBS();
  await obs.call('PauseRecord');
}

async function resumeRecording() {
  await connectOBS();
  await obs.call('ResumeRecord');
}

// --- AUTO SWITCH LOGIC ---

let autoSwitchActive = false;
let autoSwitchInterval = null;

/**
 * Démarre l'auto-switch : change automatiquement de scène selon une règle simple (exemple cyclique)
 * @param {string[]} scenes - Liste des noms de scènes à cycler
 * @param {number} intervalMs - Intervalle en ms entre chaque switch
 */
function startAutoSwitch(scenes = [], intervalMs = 5000) {
  if (!scenes.length) return;
  if (autoSwitchActive) return;
  let idx = 0;
  autoSwitchActive = true;
  autoSwitchInterval = setInterval(async () => {
    if (!autoSwitchActive) return;
    try {
      await setCurrentScene(scenes[idx]);
      idx = (idx + 1) % scenes.length;
    } catch (e) {
      // Optionnel : log l'erreur
    }
  }, intervalMs);
}

/**
 * Stoppe l'auto-switch
 */
function stopAutoSwitch() {
  autoSwitchActive = false;
  if (autoSwitchInterval) clearInterval(autoSwitchInterval);
  autoSwitchInterval = null;
}

/**
 * Change la scène courante OBS
 * @param {string} sceneName
 */
async function setCurrentScene(sceneName) {
  await connectOBS();
  await obs.call('SetCurrentProgramScene', { sceneName });
}

/**
 * Charge un profil JSON (par défaut: ./config/profile.json)
 * @param {string} profilePath
 * @returns {object}
 */
function loadProfile(profilePath = path.join(__dirname, 'config', 'profile.json')) {
  const json = fs.readFileSync(profilePath, 'utf-8');
  return JSON.parse(json);
}

/**
 * Démarre l'auto-switch selon le profil JSON
 * - Utilise les caméras/scènes et durées du profil
 * - Prend en compte le poids si besoin (par défaut cyclique)
 * @param {string} profilePath
 */
function startAutoSwitchFromProfile(profilePath) {
  const profile = loadProfile(profilePath);
  const autocam = profile.settings.autocam[0];
  const container = autocam.containers[0];
  const sources = container.sources.map(s => s.name);
  const minDuration = (container.durations?.min || 3) * 1000;
  // Pour un switch cyclique simple avec durée min
  startAutoSwitch(sources, minDuration);
}

/**
 * Démarre l'auto-switch OBS selon le profil sélectionné (par nom)
 * @param {string} profileName Exemple: 'TableRonde_1'
 */
function startAutoSwitchFromProfileName(profileName) {
  const profilePath = path.join(__dirname, 'config', `${profileName}.json`);
  return startAutoSwitchFromProfile(profilePath);
}

module.exports = {
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
  connectOBS,
  setCurrentScene,
  startAutoSwitch,
  stopAutoSwitch,
  loadProfile,
  startAutoSwitchFromProfile,
  startAutoSwitchFromProfileName
};
