// obsControl.js
// Contrôle OBS via WebSocket pour démarrer/arrêter/enregistrer depuis l'UI Gabin

const OBSWebSocket = require('obs-websocket-js').default;
const obs = new OBSWebSocket();

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

module.exports = { startRecording, stopRecording, pauseRecording, resumeRecording, connectOBS };
