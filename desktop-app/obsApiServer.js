// obsApiServer.js
// Petit serveur HTTP local pour piloter OBS depuis l'UI Gabin

if (!process.argv.includes('--as-api-server')) {
  process.exit(0);
}

const express = require('express');
const { startRecording, stopRecording, pauseRecording, resumeRecording } = require('./obsControl');
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

app.listen(port, () => {
  console.log('OBS control API listening on port', port);
});
