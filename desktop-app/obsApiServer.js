// obsApiServer.js
// Petit serveur HTTP local pour piloter OBS depuis l'UI Gabin

if (!process.argv.includes('--as-api-server')) {
  process.exit(0);
}

const express = require('express');
const { startRecording, stopRecording, pauseRecording, resumeRecording, connectOBS } = require('./obsControl');
const app = express();
const port = 3030;

app.use(express.json());

app.post('/obs/record/start', async (req, res) => {
  try {
    await startRecording();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/obs/record/stop', async (req, res) => {
  try {
    await stopRecording();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/obs/record/pause', async (req, res) => {
  try {
    await pauseRecording();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/obs/record/resume', async (req, res) => {
  try {
    await resumeRecording();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/obs/status', async (req, res) => {
  try {
    // On tente une commande simple pour vérifier la connexion OBS
    await connectOBS();
    res.json({ connected: true });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

app.listen(port, () => {
  console.log('OBS control API listening on port', port);
});
