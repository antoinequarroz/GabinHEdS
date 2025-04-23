<template>
  <div class="camera-setup-bg camera-setup-fullscreen">
    <div class="camera-setup-container camera-setup-no-border">
      <h2 class="camera-setup-title">Configuration des caméras</h2>
      <div class="camera-setup-grid" :class="`cameras-${cameraGridCount}`">
        <div v-for="n in cameraCount" :key="n" class="camera-setup-card">
          <div class="camera-setup-card-inner">
            <!-- Aperçu vidéo réel de la caméra -->
            <video
              v-if="videoStreams[n-1]"
              :ref="el => videoElements[n-1] = el"
              autoplay
              muted
              playsinline
              class="camera-preview-video"
            ></video>
            <div v-else class="camera-preview-placeholder">
              <i class="pi pi-video camera-setup-icon"></i>
            </div>
            <div class="camera-setup-label">Caméra {{ n }}</div>
          </div>
        </div>
        <!-- Case HDMI/PC pour Powerpoint sonorisé -->
        <div v-if="showHdmiCase" class="camera-setup-card hdmi-card">
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
const cameraCount = computed(() => participantCount.value <= 2 ? 2 : 3)
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

onMounted(() => {
  setupCameras()
})
onBeforeUnmount(() => {
  // Stoppe tous les flux vidéo pour libérer les caméras
  videoStreams.value.forEach(stream => {
    if (stream) stream.getTracks().forEach(track => track.stop())
  })
  if (hdmiStream.value) hdmiStream.value.getTracks().forEach(track => track.stop())
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
.camera-setup-grid {
  display: flex;
  gap: 48px;
  justify-content: center;
  align-items: stretch;
  margin-bottom: 2.5rem;
}
.camera-setup-card {
  background: linear-gradient(135deg, #223b6b 0%, #0B213F 100%);
  border-radius: 24px;
  border: none;
  box-shadow: none;
  width: 220px;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}
.camera-setup-card-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.2rem;
}
.camera-preview-video {
  width: 180px;
  height: 110px;
  border-radius: 16px;
  object-fit: cover;
  background: #000;
  margin-bottom: 1.2rem;
}
.camera-preview-placeholder {
  width: 180px;
  height: 110px;
  border-radius: 16px;
  background: #222b;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 1.2rem;
}
.camera-setup-icon {
  font-size: 3.5rem;
  color: #f3c300;
  margin-bottom: 0.5rem;
}
.camera-setup-label {
  font-size: 1.3rem;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.01em;
}
.camera-setup-info {
  color: #fff;
  font-size: 1.1rem;
  margin-top: 1.2rem;
  text-align: center;
  opacity: 0.92;
}
.hdmi-card {
  border: 2.5px solid #f3c300;
  background: linear-gradient(135deg, #2a3f6b 0%, #1d2c4f 100%);
  width: 220px;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
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
  color: #f3c300;
}
.hdmi-card select {
  margin-left: 1rem;
  background: #0B213F;
  color: #fff;
  border: 1.5px solid #f3c300;
  border-radius: 12px;
  padding: 0.2rem 0.6rem;
  font-size: 1rem;
}
.hdmi-card select:focus {
  outline: none;
  border-color: #fff;
}
.cameras-2 .camera-setup-card { width: 260px; }
.cameras-3 .camera-setup-card { width: 200px; }
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
    gap: 32px;
    width: 100vw;
    max-width: 98vw;
  }
  .camera-setup-container {
    padding: 1.5rem 0.5rem;
  }
}
</style>
