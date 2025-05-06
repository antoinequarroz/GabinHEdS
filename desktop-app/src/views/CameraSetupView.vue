<template>
  <div class="camera-setup-bg camera-setup-fullscreen">
    <div class="camera-setup-container camera-setup-no-border">
      <h1 class="page-title">Configurer les caméras</h1>
      <div class="page-subtitle">Vérifiez le cadrage et la qualité vidéo avant de commencer</div>
      <div class="camera-setup-grid" :class="`cameras-${cameraGridCount}`">
        <div v-for="n in cameraCount" :key="n" class="camera-setup-card" :class="{ 'camera-ready': videoStreams[n-1] }">
          <div class="camera-setup-card-inner">
            <template v-if="videoStreams[n-1]">
              <video
                :ref="el => videoElements[n-1] = el"
                autoplay
                muted
                playsinline
                class="camera-preview-video"
              ></video>
            </template>
            <template v-else>
              <div class="camera-preview-placeholder camera-preview-disconnected">
                <i class="pi pi-video-slash camera-setup-icon-disconnected"></i>
                <span class="camera-disconnected-text">Caméra non connectée</span>
              </div>
            </template>
            <div class="camera-setup-label">Caméra {{ n }}</div>
          </div>
        </div>
      </div>
      <div class="camera-setup-labels">
        <!-- empty -->
      </div>
      <!-- Case HDMI/PC pour Powerpoint sonorisé -->
      <div v-if="showHdmiCase" class="hdmi-card">
        <div class="camera-setup-card-inner">
          <template v-if="hdmiStream">
            <video
              ref="hdmiVideoEl"
              autoplay
              muted
              playsinline
              class="camera-preview-video"
            ></video>
          </template>
          <template v-else>
            <div class="hdmi-preview-placeholder">
              <i class="pi pi-desktop hdmi-setup-icon"></i>
            </div>
          </template>
          <div class="camera-setup-label">
            PC/HDMI
            <select v-if="showHdmiCase && hdmiDevices.length > 0" v-model="selectedHdmiDeviceId" @change="changeHdmiSource">
              <option v-for="device in hdmiDevices" :key="device.deviceId" :value="device.deviceId">
                {{ device.label || ('Source HDMI ' + (hdmiDevices.indexOf(device)+1)) }}
              </option>
            </select>
          </div>
        </div>
      </div>
      <div class="camera-setup-actions">
        <button class="camera-setup-back" @click="goBack">
          <i class="pi pi-arrow-left"></i> Retour
        </button>
        <button class="camera-setup-next" :disabled="nextDisabled" @click="confirmSelection">
          Continuer <i class="pi pi-arrow-right"></i>
        </button>
      </div>
      <div class="camera-setup-info">
        <span>{{ cameraCount + (showHdmiCase ? 1 : 0) }} source<span v-if="cameraCount + (showHdmiCase ? 1 : 0) > 1">s</span> pour {{ participantCount }} participant<span v-if="participantCount > 1">s</span>.</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
const route = useRoute()
const router = useRouter()
const participantCount = computed(() => parseInt(route.query.count) || 1)
const modality = computed(() => route.query.modality || '')
const cameraCount = computed(() => 3)
const showHdmiCase = computed(() => modality.value === 'powerpoint')
const cameraGridCount = computed(() => cameraCount.value + (showHdmiCase.value ? 1 : 0))

const nextDisabled = computed(() => {
  // Si HDMI requis (PowerPoint), il faut une sélection HDMI valide
  if (showHdmiCase.value) {
    return !selectedHdmiDeviceId.value;
  }
  // Sinon, bouton toujours actif
  return false;
});

const videoStreams = ref([])
const videoElements = []

// HDMI selection logic
const hdmiDevices = ref([])
const selectedHdmiDeviceId = ref('')
const hdmiStream = ref(null)
const hdmiVideoEl = ref(null)

async function setupCameras() {
  // Récupère la liste des caméras disponibles
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')
  // Caméras classiques
  for (let i = 0; i < cameraCount.value; i++) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: devices[i]?.deviceId } },
        audio: false
      })
      videoStreams.value[i] = stream
      // Attache le flux à la balise <video>
      setTimeout(() => {
        if (videoElements[i]) videoElements[i].srcObject = stream
      }, 0)
    } catch (e) {
      videoStreams.value[i] = null
    }
  }
  // HDMI (carte de capture)
  if (showHdmiCase.value) {
    // On prend les devices vidéo restants après les caméras
    hdmiDevices.value = devices.slice(cameraCount.value)
    // Par défaut, on prend le premier device dispo
    if (hdmiDevices.value.length > 0) {
      selectedHdmiDeviceId.value = hdmiDevices.value[0].deviceId
      await setupHdmiStream(selectedHdmiDeviceId.value)
    }
  }
}

async function setupHdmiStream(deviceId) {
  if (hdmiStream.value) {
    hdmiStream.value.getTracks().forEach(track => track.stop())
    hdmiStream.value = null
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
      audio: false
    })
    hdmiStream.value = stream
    setTimeout(() => {
      if (hdmiVideoEl.value) hdmiVideoEl.value.srcObject = stream
    }, 0)
  } catch (e) {
    hdmiStream.value = null
  }
}

function changeHdmiSource() {
  setupHdmiStream(selectedHdmiDeviceId.value)
}

function goBack() {
  router.back()
}

function confirmSelection() {
  // Nettoyer les streams si besoin
  videoStreams.value.forEach(stream => {
    if (stream) stream.getTracks().forEach(track => track.stop())
  });
  if (hdmiStream.value) hdmiStream.value.getTracks().forEach(track => track.stop());
  // Aller à la vue de contrôle du live
  router.push({ name: 'LiveControl' });
}

function handleKeydown(e) {
  if ((e.key === 'Enter' || e.key === ' ') && !nextDisabled.value) confirmSelection()
  if (e.key.toLowerCase() === 'r') goBack()
}

onMounted(() => {
  setupCameras()
  window.addEventListener('keydown', handleKeydown)
})
onBeforeUnmount(() => {
  // Stoppe tous les flux vidéo pour libérer les caméras
  videoStreams.value.forEach(stream => {
    if (stream) stream.getTracks().forEach(track => track.stop())
  })
  if (hdmiStream.value) hdmiStream.value.getTracks().forEach(track => track.stop())
  window.removeEventListener('keydown', handleKeydown)
})

// Si l'utilisateur change la sélection HDMI
watch(selectedHdmiDeviceId, (id) => {
  if (id) setupHdmiStream(id)
})
</script>

<style scoped>
.camera-setup-bg {
  min-height: 100vh;
  width: 100vw;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  overflow: hidden;
}
.camera-setup-fullscreen {
  min-height: 100vh;
  width: 100vw;
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  overflow: hidden;
}
.camera-setup-container {
  background: transparent;
  border-radius: 0;
  border: none;
  box-shadow: none;
  padding: 0;
  width: 100vw;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2.5rem;
  box-sizing: border-box;
  overflow: hidden;
}
.camera-setup-no-border {
  background: transparent;
  border: none;
  box-shadow: none;
}
.camera-setup-title {
  color: #fff;
  font-size: 2.3rem;
  font-weight: 700;
  margin-bottom: 2.5rem;
  text-align: center;
  letter-spacing: 0.02em;
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
.camera-setup-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 48px 36px;
  justify-content: center;
  align-items: flex-start;
  margin-bottom: 2.5rem;
  width: 100vw;
  max-width: 100vw;
  overflow-x: auto;
}
.camera-setup-card {
  width: 520px;
  min-height: 320px;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  border-radius: 24px;
  box-shadow: 0 6px 40px 0 #0B213F44, 0 1.5px 8px #f3c30033;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border: 2.5px solid transparent;
  position: relative;
  overflow: visible;
  flex-direction: column;
  padding: 0;
  margin-bottom: 0.5rem;
}
.camera-setup-card.selected,
.camera-setup-card.camera-ready {
  border: 2.5px solid #f3c300 !important;
  box-shadow: 0 8px 40px 0 #f3c30099, 0 2px 12px #fff2;
  animation: card-pop 0.22s cubic-bezier(.4,2,.6,1) 1;
}
@keyframes card-pop {
  0% { transform: scale(1); }
  60% { transform: scale(1.09); }
  100% { transform: scale(1.04); }
}
.camera-setup-card-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 0;
  box-sizing: border-box;
}
.camera-preview-video, .camera-preview-placeholder {
  width: 480px;
  height: 270px;
  border-radius: 18px;
  object-fit: cover;
  background: #000;
  margin-bottom: 0.7rem;
}
@media (max-width: 900px) {
  .camera-preview-video, .camera-preview-placeholder {
    width: 92vw;
    height: calc(92vw * 0.5625);
    border-radius: 10px;
  }
}
.camera-preview-placeholder.camera-preview-disconnected {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, #232c3b 70%, #0B213F 100%);
  border-radius: 18px;
  border: 2px solid #fff3;
  color: #fff8;
  position: relative;
  min-height: 180px;
}
.camera-setup-icon-disconnected {
  font-size: 3.2rem;
  color: #fff4;
  margin-bottom: 0.5rem;
}
.camera-disconnected-text {
  font-size: 1.1rem;
  color: #fff;
  opacity: 0.85;
  text-shadow: 0 2px 8px #000b;
  margin-top: 0.2rem;
}
.camera-setup-label {
  font-size: 1.3rem;
  font-weight: 700;
  color: #fff;
  text-align: center;
  margin-bottom: 0.2rem;
  letter-spacing: 0.01em;
  line-height: 1.1;
  word-break: break-word;
  white-space: normal;
  text-shadow: 0 2px 8px #000c;
  background: rgba(20,30,50,0.7);
  border-radius: 12px;
  padding: 0.3rem 1.2rem;
  display: inline-block;
}
.hdmi-card {
  width: 320px;
  min-height: 240px;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  border-radius: 32px;
  box-shadow: 0 6px 40px 0 #0B213F44, 0 1.5px 8px #f3c30033;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: box-shadow 0.18s, transform 0.18s, border 0.18s;
  border: 2.5px solid transparent;
  position: relative;
  overflow: hidden;
  flex-direction: column;
}
.hdmi-preview-placeholder {
  width: 180px;
  height: 110px;
  border-radius: 16px;
  background: #222b;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 1.2rem;
}
.hdmi-setup-icon {
  font-size: 3.5rem;
  color: #0B213F;
}
.camera-setup-actions {
  display: flex;
  flex-direction: row;
  gap: 2rem;
  justify-content: center;
  align-items: center;
  margin-bottom: 1.5rem;
}
.camera-setup-back, .camera-setup-next {
  background: #0B213F;
  color: #fff;
  font-size: 1.2rem;
  font-weight: 700;
  border-radius: 18px;
  border: none;
  padding: 1rem 2.2rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.7rem;
}
.camera-setup-back {
  background: #fff3;
  color: #f3c300;
}
.camera-setup-back:hover {
  background: #f3c300;
  color: #0B213F;
}
.camera-setup-next {
  background: #f3c300;
  color: #0B213F;
}
.camera-setup-next:disabled {
  background: #fff3;
  color: #fff8;
  cursor: not-allowed;
}
@media (max-width: 900px) {
  .camera-setup-grid {
    flex-direction: column;
    gap: 18px;
    width: 100vw;
    max-width: 98vw;
  }
  .camera-setup-card {
    width: 98vw;
    min-height: 180px;
    border-radius: 12px;
  }
}
</style>
