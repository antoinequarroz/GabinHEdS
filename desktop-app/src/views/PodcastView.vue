<template>
  <div class="modality-onboarding-bg podcast-bg">
    <Button class="podcast-back-btn" icon="pi pi-arrow-left" @click="$router.back()" aria-label="Retour" />
    <div class="modality-onboarding-container podcast-container">
      <div class="podcast-header">
        <h1 class="page-title">Enregistrer le podcast</h1>
        <div class="page-subtitle">Lancez l'enregistrement et suivez le déroulé de la session</div>
      </div>
      <div class="mic-list">
        <MicrophoneCard
          v-for="(mic, idx) in microphones"
          :key="mic.deviceId"
          :label="mic.label"
          :level="mic.level"
          :soundOk="mic.soundOk"
          :index="idx"
        />
      </div>
      <div class="podcast-controls">
        <button @click="onRec" :disabled="isRecording" class="rec-btn">
          <i class="pi pi-circle-fill"></i> REC
        </button>
        <button @click="onPause" :disabled="!isRecording || isPaused" class="pause-btn">
          <i class="pi pi-pause"></i> Pause
        </button>
        <button @click="onStop" :disabled="!isRecording" class="stop-btn">
          <i class="pi pi-stop"></i> Stop
        </button>
        <span v-if="isRecording" class="recording-timer">{{ formattedTimer }}</span>
      </div>
      <div class="obs-controls">
        <Button label="Enregistrer via OBS" icon="pi pi-circle-on" class="obs-btn obs-rec-btn" @click="startOBSRec" :disabled="obsRec || !obsConnected" />
        <Button label="Stop OBS" icon="pi pi-stop" class="obs-btn obs-stop-btn" @click="stopOBSRec" :disabled="!obsRec || !obsConnected" />
        <span v-if="obsConnected" class="obs-status" :class="{rec: obsRec}">{{ obsRec ? 'Enregistrement OBS en cours' : 'OBS prêt' }}</span>
        <span v-else class="obs-status error">OBS non connecté</span>
        <span v-if="obsError" class="obs-status error">{{ obsError }}</span>
      </div>
      <div class="recordings-list" v-if="recordings.length">
        <h2>Enregistrements</h2>
        <ul>
          <li v-for="(rec, i) in recordings" :key="i">
            <audio :src="rec.url" controls></audio>
            <span>{{ rec.name }}</span>
            <a :href="rec.urlMp3 || rec.url" :download="rec.name.replace('.webm', '.mp3')" class="download-btn">Télécharger MP3</a>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script>
import lamejs from 'lamejs'
import MicrophoneCard from '../components/MicrophoneCard.vue'
import Button from 'primevue/button'
// import { ipcRenderer } from 'electron';

let obsSocket = null;

export default {
  name: 'PodcastView',
  components: { MicrophoneCard, Button },
  data() {
    return {
      microphones: [],
      isRecording: false,
      isPaused: false,
      mediaRecorder: null,
      audioChunks: [],
      recordings: [],
      timer: 0,
      timerInterval: null,
      nbPersons: 2,
      audioContext: null,
      analyser: null,
      stream: null,
      obsConnected: false,
      obsRec: false,
      obsError: null,
    };
  },
  computed: {
    formattedTimer() {
      const m = String(Math.floor(this.timer / 60)).padStart(2, '0');
      const s = String(this.timer % 60).padStart(2, '0');
      return `${m}:${s}`;
    }
  },
  methods: {
    async getMicrophones() {
      const nb = parseInt(this.$route.query.count) || 1;
      this.nbPersons = nb;
      const devices = await navigator.mediaDevices.enumerateDevices();
      // Ne garder que les micros Rodecaster Pro (ou tous, à filtrer ensuite)
      const mics = devices.filter(d => d.kind === 'audioinput').slice(0, this.nbPersons);
      this.microphones = mics.map(m => ({
        ...m,
        level: 0,
        soundOk: false
      }));
    },
    async setupAudioLevel() {
      // Prend le premier micro pour la démo (améliorable pour multi-mic)
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      source.connect(this.analyser);
      this.analyser.fftSize = 256;
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      const updateLevel = () => {
        this.analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        this.microphones[0].level = Math.min(100, Math.round((avg / 255) * 100));
        this.microphones[0].soundOk = avg > 10;
        requestAnimationFrame(updateLevel);
      };
      updateLevel();
    },
    // --- OBS CONTROL ---
    connectOBS() {
      if (obsSocket) return;
      obsSocket = new WebSocket('ws://localhost:4455');
      obsSocket.onopen = () => {
        this.obsConnected = true;
        this.obsError = null;
        // Request current recording state
        this.sendOBS({op: 6, d: {requestType: 'GetRecordStatus', requestId: 'getrec'}});
      };
      obsSocket.onclose = () => {
        this.obsConnected = false;
        this.obsRec = false;
        obsSocket = null;
      };
      obsSocket.onerror = (e) => {
        this.obsError = 'Erreur de connexion OBS';
        this.obsConnected = false;
      };
      obsSocket.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data.op === 7 && data.d && data.d.requestType === 'GetRecordStatus') {
            this.obsRec = data.d.responseData.outputActive;
          }
          if (data.op === 5 && data.d.eventType === 'RecordStateChanged') {
            this.obsRec = data.d.eventData.outputActive;
          }
        } catch(e) {}
      };
    },
    sendOBS(payload) {
      if (obsSocket && obsSocket.readyState === 1) {
        obsSocket.send(JSON.stringify(payload));
      }
    },
    startOBSRec() {
      this.sendOBS({op: 6, d: {requestType: 'StartRecord', requestId: 'startrec'}});
    },
    stopOBSRec() {
      this.sendOBS({op: 6, d: {requestType: 'StopRecord', requestId: 'stoprec'}});
    },
    // --- END OBS CONTROL ---
    async onRec() {
      if (this.isRecording) return;
      this.audioChunks = [];
      this.mediaRecorder = new MediaRecorder(this.stream);
      this.mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };
      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const name = `podcast_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
        // Conversion mp3 côté client (simple, qualité basique)
        let urlMp3 = null;
        urlMp3 = await this.convertToMp3(blob);
        this.recordings.unshift({ url, name, urlMp3 });
      };
      this.mediaRecorder.start();
      this.isRecording = true;
      this.isPaused = false;
      this.timer = 0;
      this.timerInterval = setInterval(() => this.timer++, 1000);
    },
    onPause() {
      if (this.mediaRecorder && this.isRecording && !this.isPaused) {
        this.mediaRecorder.pause();
        this.isPaused = true;
      }
    },
    onStop() {
      if (this.mediaRecorder && this.isRecording) {
        this.mediaRecorder.stop();
        this.isRecording = false;
        this.isPaused = false;
        clearInterval(this.timerInterval);
      }
    },
    async convertToMp3(blob) {
      // Conversion mp3 avec lamejs
      return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => {
          const wav = new Uint8Array(reader.result);
          const mp3encoder = new lamejs.Mp3Encoder(1, 44100, 128);
          const mp3Data = mp3encoder.encodeBuffer(wav);
          const mp3Blob = new Blob([new Uint8Array(mp3Data)], { type: 'audio/mp3' });
          resolve(URL.createObjectURL(mp3Blob));
        };
        reader.readAsArrayBuffer(blob);
      });
    },
    handleKeydown(e) {
      if ((e.key === 'Enter' || e.key === ' ') && !this.isRecording) this.onRec()
      if ((e.key === 'Enter' || e.key === ' ') && this.isRecording) this.onStop()
      if (e.key.toLowerCase() === 'r') this.$router.back()
    },
  },
  mounted() {
    this.getMicrophones();
    this.setupAudioLevel();
    this.connectOBS();
    window.addEventListener('keydown', this.handleKeydown)
  },
  beforeUnmount() {
    if (this.audioContext) this.audioContext.close();
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (obsSocket) obsSocket.close();
    window.removeEventListener('keydown', this.handleKeydown)
  }
}
</script>

<style scoped>
.podcast-bg {
  min-height: 100vh;
  min-width: 100vw;
  width: 100vw;
  height: 100vh;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 0;
  overflow: hidden;
  position: relative;
}
.podcast-container {
  min-height: 100vh;
  min-width: 100vw;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(13, 31, 63, 0.97);
  padding: 0;
}
.podcast-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2rem;
  margin-bottom: 2rem;
  margin-top: 2.5rem;
}
.page-title {
  font-size: 2.7rem;
  font-weight: 900;
  color: #f3c300;
  margin-bottom: 0.2em;
  letter-spacing: 1px;
  text-align: center;
}
.page-subtitle {
  font-size: 1.25rem;
  color: #fff;
  font-weight: 400;
  margin-bottom: 1.2em;
  text-align: center;
  opacity: 0.88;
}
.podcast-title {
  font-size: 2.7rem;
  letter-spacing: 1px;
  font-weight: 900;
  margin-bottom: 2rem;
  margin-top: 2.5rem;
  color: #fff;
  text-align: center;
}
.mic-list {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 3.5rem;
  width: 100vw;
  min-height: 70vh;
  height: 70vh;
}
.podcast-controls {
  margin-bottom: 2.5rem;
  display: flex;
  align-items: center;
  gap: 2.5rem;
  justify-content: center;
}
.rec-btn, .pause-btn, .stop-btn {
  background: #181e2a;
  color: #fff;
  border: none;
  border-radius: 1rem;
  padding: 1.2rem 2.7rem;
  font-size: 1.5rem;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.18s, color 0.18s;
  display: flex;
  align-items: center;
  gap: 0.7rem;
}
.rec-btn {
  background: #f44336;
}
.pause-btn {
  background: #ffeb3b;
  color: #232b3e;
}
.stop-btn {
  background: #2196f3;
}
.rec-btn:disabled, .pause-btn:disabled, .stop-btn:disabled {
  background: #8884;
  color: #fff8;
  cursor: not-allowed;
}
.recording-timer {
  font-size: 1.5rem;
  color: #f44336;
  font-weight: bold;
}
.recordings-list {
  width: 100%;
  max-width: 800px;
  margin-top: 2.5rem;
  background: #232b3e;
  border-radius: 2rem;
  padding: 2rem;
  box-shadow: 0 2px 24px 0 #0009;
}
.recordings-list h2 {
  margin-bottom: 1.3rem;
  color: #90caf9;
}
.recordings-list ul {
  list-style: none;
  padding: 0;
}
.recordings-list li {
  display: flex;
  align-items: center;
  gap: 1.2rem;
  margin-bottom: 1.2rem;
}
.download-btn {
  background: #4caf50;
  color: #fff;
  border: none;
  border-radius: 0.8rem;
  padding: 0.7rem 1.5rem;
  font-size: 1.1rem;
  font-weight: 700;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.18s, color 0.18s;
}
.download-btn:hover {
  background: #388e3c;
}
.podcast-back-btn {
  position: absolute;
  top: 2vw;
  left: 2vw;
  z-index: 20;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  border-radius: 50%;
  box-shadow: 0 2px 12px #0007;
  width: 3.3rem;
  height: 3.3rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.7rem;
  color: #f3c300;
  border: 2px solid #f3c30066;
  transition: background 0.18s, box-shadow 0.18s, color 0.18s;
}
.podcast-back-btn:hover {
  background: #f3c300 !important;
  color: #0B213F !important;
  box-shadow: 0 4px 16px #f3c30099;
}
.obs-controls {
  display: flex;
  gap: 1.5rem;
  align-items: center;
  justify-content: center;
  margin-bottom: 2.5rem;
}
.obs-btn {
  font-size: 1.18rem;
  font-weight: 700;
  border-radius: 18px;
  padding: 0.8rem 2.1rem;
  background: #1e335c;
  color: #f3c300;
  border: 2px solid #f3c30044;
  transition: background 0.18s, color 0.18s, box-shadow 0.18s;
}
.obs-btn.obs-rec-btn {
  background: #f3c300;
  color: #0B213F;
}
.obs-btn.obs-stop-btn {
  background: #e53935;
  color: #fff;
}
.obs-btn:disabled {
  background: #fff3;
  color: #fff8;
  cursor: not-allowed;
}
.obs-status {
  font-size: 1.1rem;
  font-weight: 700;
  margin-left: 1.2rem;
  color: #f3c300;
}
.obs-status.rec {
  color: #e53935;
}
.obs-status.error {
  color: #f44336;
}
</style>
