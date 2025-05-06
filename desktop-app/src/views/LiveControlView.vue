<template>
  <div class="live-full-bg">
    <h1 class="page-title">Contrôler le flux</h1>
    <div class="page-subtitle">Gérez le flux de la session</div>
    <Button class="live-back-btn" icon="pi pi-arrow-left" @click="goBack" aria-label="Retour" />
    <div class="auto-regie-status">
      <div class="auto-current" v-if="autoCurrent">
        <span>Auto-régie : </span><b>{{ autoCurrent }}</b>
      </div>
      <div class="auto-log" v-if="autoLog.length">
        <div class="auto-log-title">Historique auto-régie</div>
        <ul>
          <li v-for="item in autoLog" :key="item.time + item.event">
            <span class="auto-log-time">[{{ item.time }}]</span> {{ item.event }}
          </li>
        </ul>
      </div>
    </div>
    <div v-if="obsConnected && videoAvailable">
      <video ref="videoRef" controls autoplay class="live-full-video" style="width:100%;"></video>
    </div>
    <div v-else class="no-video-placeholder">
      <i class="pi pi-video-off" style="font-size: 6rem; color: #f3c300;" />
      <p>Aucun retour vidéo OBS disponible</p>
    </div>
    <div class="live-overlay-controls">
      <Button v-if="!isRecording" label="REC" icon="pi pi-circle-on" class="p-button-success live-action-btn rec-btn" @click="onStartRec" />
      <Button v-else label="STOP" icon="pi pi-stop" class="p-button-danger live-action-btn stop-btn" @click="onStopRec" />
      <Button v-if="isRecording" :label="isPaused ? 'RESUME' : 'PAUSE'" icon="pi pi-pause" class="p-button-warning live-action-btn pause-btn" @click="onPauseRec" />
    </div>
    <div class="live-overlay-info">
      <div class="obs-status" :class="{ connected: obsConnected, disconnected: !obsConnected }">
        <i :class="obsConnected ? 'pi pi-check-circle' : 'pi pi-times-circle'"/>
        <span>{{ obsConnected ? 'OBS connecté' : 'OBS non connecté' }}</span>
      </div>
      <div class="scene-status">
        <p>Scène active : <b>{{ currentScene }}</b></p>
        <div>
          <span v-for="scene in scenes" :key="scene.name" style="margin-right: 1rem;">
            <Button :label="scene.name" :class="scene.active ? 'p-button-info' : 'p-button-secondary'" @click="switchScene(scene.name)" />
          </span>
        </div>
        <p v-if="isRecording && !isPaused" style="color:red; font-weight:bold;">● Enregistrement en cours</p>
        <p v-if="isRecording && isPaused" style="color:orange; font-weight:bold;">⏸️ Enregistrement en pause</p>
      </div>
      <div class="audio-status">
        <i :class="audioOk ? 'pi pi-volume-up' : 'pi pi-volume-off'" :style="audioOk ? 'color:#4caf50' : 'color:#f44336'" />
        <span class="audio-status-label">{{ audioOk ? 'Son OK' : 'Problème audio' }}</span>
      </div>
    </div>
    <div class="camera-switch-panel">
      <div v-for="(name, idx) in cameraSources" :key="name" style="margin-bottom: 8px;">
        <Button :label="cameraStates[idx] ? `Masquer ${name}` : `Afficher ${name}`" @click="toggleCamera(idx)" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import Button from 'primevue/button';
import { obsClient } from '@/obs'
import { autocamClient } from '@/obs/AutocamClient'
import Hls from 'hls.js'

const router = useRouter();
const route = useRoute();

function goBack() {
  router.back();
}

const isRecording = ref(false);
const isPaused = ref(false);

const audioOk = ref(true);
const currentScene = ref(undefined)
const scenes = ref([])
const obsConnected = ref(false)
const videoAvailable = ref(true)
const OBS_HLS_URL = 'http://localhost:8081/hls/test.m3u8'

const cameraSources = ref([])

const cameraStates = ref(cameraSources.value.map(() => true)) // true = visible

function toggleCamera(idx) {
  const sourceName = cameraSources.value[idx]
  const newState = !cameraStates.value[idx]
  cameraStates.value[idx] = newState
  obsClient.setCameraEnabled(sourceName, newState)
}

const autoLog = ref([])
const autoCurrent = ref('')

// Simule un flux d'événements auto-régie (à remplacer par une vraie source si backend)
function pushAutoEvent(event) {
  autoCurrent.value = event
  autoLog.value.unshift({ event, time: new Date().toLocaleTimeString() })
  if (autoLog.value.length > 10) autoLog.value.length = 10
}

const videoRef = ref(null)
let hls

onMounted(async () => {
  obsClient.connect()

  if (route.query.modality === 'tableronde' || route.query.modality === 'roundtable') {
    // Passe automatiquement sur la scène Table Ronde (sans démarrer l'enregistrement)
    await obsClient.setTableRondeScene({ startRecording: false })
  }

  if (videoRef.value) {
    if (Hls.isSupported()) {
      hls = new Hls()
      hls.loadSource(OBS_HLS_URL)
      hls.attachMedia(videoRef.value)
    } else if (videoRef.value.canPlayType('application/vnd.apple.mpegurl')) {
      videoRef.value.src = OBS_HLS_URL
    }
  }

  const sub1 = obsClient.activeScene$.subscribe(scene => {
    currentScene.value = scene
    if (scene) pushAutoEvent(`Scène auto-sélectionnée : ${scene}`)
  })
  const sub2 = obsClient.scenes$.subscribe(list => {
    scenes.value = list.map(s => ({ ...s, active: s.name === currentScene.value }))
  })
  const sub3 = obsClient.recording$.subscribe(val => {
    isRecording.value = val
  })
  const sub4 = obsClient.paused$.subscribe(val => {
    isPaused.value = val
  })
  const sub5 = obsClient.obsConnected$.subscribe(val => {
    obsConnected.value = val
  })

  onBeforeUnmount(() => {
    sub1.unsubscribe()
    sub2.unsubscribe()
    sub3.unsubscribe()
    sub4.unsubscribe()
    sub5.unsubscribe()
  })
})

onBeforeUnmount(() => {
  if (hls) hls.destroy()
})

function handleKeydown(e) {
  if (e.key === 'Enter' || e.key === ' ') onStartRec()
  if (e.key.toLowerCase() === 'r') goBack()
}

function onStartRec() {
  obsClient.startRecording()
}
function onPauseRec() {
  if (!isRecording.value) return;
  if (!isPaused.value) {
    obsClient.pauseRecording()
  } else {
    obsClient.resumeRecording()
  }
}
function onStopRec() {
  obsClient.stopRecording()
}
function switchScene(sceneName) {
  obsClient.setScene(sceneName)
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
.no-video-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 50vh;
  color: #f3c300;
  background: #19233a;
  border-radius: 24px;
  margin: 2rem;
  font-size: 2rem;
}
.camera-switch-panel {
  position: absolute;
  bottom: 10vw;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 1.2rem;
  z-index: 10;
  background: rgba(24,38,75,0.80);
  border-radius: 16px;
  padding: 0.7rem 1.1rem;
  box-shadow: 0 2px 24px #0008;
  backdrop-filter: blur(3px);
}
.auto-regie-status {
  background: #232c4b;
  color: #ffd600;
  border-radius: 10px;
  padding: 1rem 1.5rem;
  margin-bottom: 1.5rem;
  box-shadow: 0 2px 12px #0005;
  max-width: 500px;
}
.auto-current {
  font-size: 1.1rem;
  margin-bottom: 0.7rem;
}
.auto-log-title {
  font-size: 0.95rem;
  font-weight: bold;
  margin-bottom: 0.3rem;
}
.auto-log-time {
  color: #fff;
  font-size: 0.92em;
  margin-right: 0.4em;
}
.auto-log {
  max-height: 180px;
  overflow-y: auto;
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
