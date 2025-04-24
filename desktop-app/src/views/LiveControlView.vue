<template>
  <div class="live-full-bg">
    <Button class="live-back-btn" icon="pi pi-arrow-left" @click="goBack" aria-label="Retour" />
    <video ref="obsVideo" controls autoplay class="live-full-video"></video>
    <div class="live-overlay-controls">
      <Button label="REC" icon="pi pi-circle-on" class="p-button-success live-action-btn rec-btn" @click="onStartRec" :disabled="isRecording" />
      <Button label="PAUSE" icon="pi pi-pause" class="p-button-warning live-action-btn pause-btn" @click="onPauseRec" :disabled="!isRecording" />
      <Button label="STOP" icon="pi pi-stop" class="p-button-danger live-action-btn stop-btn" @click="onStopRec" :disabled="!isRecording" />
    </div>
    <div class="live-overlay-info">
      <div class="obs-status" :class="{ connected: obsConnected, disconnected: !obsConnected }">
        <i :class="obsConnected ? 'pi pi-check-circle' : 'pi pi-times-circle'"/>
        <span>{{ obsConnected ? 'OBS connecté' : 'OBS non connecté' }}</span>
      </div>
      <div class="audio-status">
        <i :class="audioOk ? 'pi pi-volume-up' : 'pi pi-volume-off'" :style="audioOk ? 'color:#4caf50' : 'color:#f44336'" />
        <span class="audio-status-label">{{ audioOk ? 'Son OK' : 'Problème audio' }}</span>
      </div>
      <div class="scene-status">
        <ul>
          <li v-for="scene in scenes" :key="scene.name" :class="{active: scene.active}">
            <span class="scene-badge" :class="{active: scene.active}">
              <i class="pi pi-video"></i>
            </span>
            {{ scene.name }}
            <span v-if="scene.active" class="switch-indicator">(Actif)</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import Hls from 'hls.js';

const router = useRouter();
function goBack() {
  router.back();
}

const isRecording = ref(false);
const isPaused = ref(false);

const audioOk = ref(true);
const scenes = ref([
  { name: 'Plan large', active: true },
  { name: 'Plan invité', active: false },
  { name: 'Plan animateur', active: false },
]);

const obsConnected = ref(false);
const obsStatusError = ref('');

const obsVideo = ref(null);
const OBS_HLS_URL = 'http://localhost:8081/index.m3u8';
let hls;

async function checkObsStatus() {
  try {
    const res = await fetch('http://localhost:3030/obs/status');
    const data = await res.json();
    obsConnected.value = !!data.connected;
    obsStatusError.value = data.error || '';
  } catch (e) {
    obsConnected.value = false;
    obsStatusError.value = e.message;
  }
}

onMounted(() => {
  checkObsStatus();
  if (Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(OBS_HLS_URL);
    hls.attachMedia(obsVideo.value);
  } else if (obsVideo.value && obsVideo.value.canPlayType('application/vnd.apple.mpegurl')) {
    obsVideo.value.src = OBS_HLS_URL;
  }
});
onUnmounted(() => {
  if (hls) hls.destroy();
});

async function onStartRec() {
  await fetch('http://localhost:3030/obs/record/start', { method: 'POST' });
  isRecording.value = true;
  isPaused.value = false;
}
async function onPauseRec() {
  if (!isRecording.value) return;
  if (!isPaused.value) {
    await fetch('http://localhost:3030/obs/record/pause', { method: 'POST' });
    isPaused.value = true;
  } else {
    await fetch('http://localhost:3030/obs/record/resume', { method: 'POST' });
    isPaused.value = false;
  }
}
async function onStopRec() {
  await fetch('http://localhost:3030/obs/record/stop', { method: 'POST' });
  isRecording.value = false;
  isPaused.value = false;
}
</script>

<style scoped>
.live-full-bg {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  width: 100vw;
  height: 100vh;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  overflow: hidden;
  z-index: 0;
}
.live-back-btn {
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
.live-back-btn:hover {
  background: #f3c300 !important;
  color: #0B213F !important;
  box-shadow: 0 4px 16px #f3c30099;
}
.live-overlay-controls {
  position: absolute;
  bottom: 3vw;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 2.5rem;
  z-index: 10;
  background: rgba(24,38,75,0.80);
  border-radius: 24px;
  padding: 1.2rem 2.5rem;
  box-shadow: 0 2px 24px #0008;
  backdrop-filter: blur(3px);
}
.live-action-btn {
  font-size: 1.3rem;
  font-weight: 700;
  border-radius: 18px;
  padding: 1.1rem 2.4rem;
  box-shadow: none;
  transition: background 0.18s, color 0.18s, box-shadow 0.18s;
}
.live-action-btn.rec-btn {
  box-shadow: 0 0 12px #e5393533;
}
.live-action-btn.pause-btn {
  box-shadow: 0 0 12px #f3c30033;
}
.live-action-btn.stop-btn {
  box-shadow: 0 0 12px #e5393533;
}
.live-action-btn:hover {
  filter: brightness(1.09) drop-shadow(0 2px 8px #f3c30044);
  transform: translateY(-2px) scale(1.04);
}
.live-overlay-info {
  position: absolute;
  top: 2vw;
  right: 2vw;
  display: flex;
  flex-direction: column;
  gap: 1.7rem;
  z-index: 10;
  align-items: flex-end;
}
.obs-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.1rem;
  font-weight: bold;
  margin-bottom: 0.7rem;
  padding: 0.6rem 1.2rem;
  border-radius: 12px;
  background: #1e335c;
  color: #fff;
  border: 2px solid #3e5a8c;
  box-shadow: 0 1px 6px #0004;
}
.obs-status.connected {
  background: #e8f5e9;
  color: #388e3c;
  border-color: #388e3c;
}
.obs-status.disconnected {
  background: #ffebee;
  color: #c62828;
  border-color: #c62828;
}
.audio-status {
  background: rgba(34,59,107,0.93);
  border-radius: 16px;
  box-shadow: 0 2px 12px #0007;
  padding: 0.7rem 1.5rem;
  color: #fff;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  font-size: 1.1rem;
  font-weight: 700;
}
.audio-status-label {
  font-size: 1.1rem;
  font-weight: 700;
}
.scene-status {
  background: rgba(34,59,107,0.93);
  border-radius: 16px;
  box-shadow: 0 2px 12px #0007;
  padding: 0.7rem 1.5rem;
  color: #fff;
  min-width: 180px;
}
.scene-status ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.scene-status li {
  padding: 0.35rem 0.2rem;
  display: flex;
  align-items: center;
  gap: 0.7rem;
  font-size: 1.02rem;
  border-radius: 8px;
  transition: background 0.16s, color 0.16s;
}
.scene-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.7rem;
  height: 1.7rem;
  border-radius: 50%;
  background: #f3c30033;
  color: #f3c300;
  font-size: 1.1rem;
  margin-right: 0.4rem;
  border: 1.5px solid #f3c30066;
  box-shadow: 0 1px 6px #f3c30022;
}
.scene-badge.active {
  background: #f3c300;
  color: #0B213F;
  border: 1.5px solid #f3c300;
  box-shadow: 0 2px 8px #f3c30055;
}
.scene-status li.active {
  background: #e3f2fd;
  font-weight: bold;
  border-radius: 8px;
  color: #1976d2;
}
.switch-indicator {
  color: #1976d2;
  margin-left: 0.5rem;
  font-size: 0.98rem;
}
.live-full-video {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: -1;
}
@media (max-width: 800px) {
  .live-overlay-controls {
    flex-direction: column;
    gap: 1.2rem;
    padding: 0.7rem 1.1rem;
    border-radius: 16px;
    bottom: 1.5vw;
  }
  .live-overlay-info {
    top: 1vw;
    right: 1vw;
    gap: 1rem;
  }
  .scene-status, .audio-status {
    min-width: 120px;
    padding: 0.5rem 0.7rem;
    font-size: 0.97rem;
  }
}
</style>

<style>
/* Dark mode pour tous les overlays PrimeVue (Dialog, OverlayPanel, Menu, ContextMenu, Dropdown, Tooltip) */
.p-dialog, .p-overlaypanel, .p-menu, .p-contextmenu, .p-dropdown-panel, .p-tooltip {
  background: #19233a !important;
  color: #fff !important;
  border: 1.5px solid #222d44 !important;
  box-shadow: 0 4px 32px #000a;
}
.p-dialog .p-dialog-header, .p-dialog .p-dialog-footer {
  background: #1e2a47 !important;
  color: #fff !important;
}
.p-menu .p-menuitem, .p-contextmenu .p-menuitem {
  background: #19233a !important;
  color: #fff !important;
}
.p-menu .p-menuitem:hover, .p-contextmenu .p-menuitem:hover {
  background: #22305a !important;
}
.p-dropdown-panel .p-dropdown-item {
  background: #19233a !important;
  color: #fff !important;
}
.p-dropdown-panel .p-dropdown-item.p-highlight,
.p-dropdown-panel .p-dropdown-item:hover {
  background: #22305a !important;
  color: #fff !important;
}
.p-tooltip {
  background: #222d44 !important;
  color: #fff !important;
  border-radius: 8px !important;
}
</style>
