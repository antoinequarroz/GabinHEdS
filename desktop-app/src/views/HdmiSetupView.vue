<template>
  <div class="camera-setup-bg camera-setup-fullscreen">
    <div class="camera-setup-container camera-setup-no-border">
      <h1 class="page-title">Configurer l'audio</h1>
      <div class="page-subtitle">Testez et ajustez le volume sonore avant d'enregistrer</div>
      <div class="micro-setup-grid" :class="`micros-${microCount}`">
        <MicrophoneCard
          v-for="n in microCount"
          :key="n"
          :index="n - 1"
          :label="`Micro ${n}`"
          :level="80"
          :soundOk="true"
        />
      </div>
      <div class="hdmi-card">
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
            <div class="hdmi-preview-placeholder camera-preview-disconnected">
              <i class="pi pi-desktop hdmi-setup-icon"></i>
              <span class="camera-disconnected-text">Source HDMI non connectée</span>
            </div>
          </template>
          <div class="camera-setup-label">
            PC/HDMI
          </div>
        </div>
      </div>
      <div class="camera-setup-actions">
        <button class="camera-setup-back" @click="goBack">
          <i class="pi pi-arrow-left"></i> Retour
        </button>
        <button class="camera-setup-next" :disabled="!hdmiStream" @click="goNext">
          Continuer <i class="pi pi-arrow-right"></i>
        </button>
      </div>
      <div class="camera-setup-info">
        <span>{{ microCount }} micro<span v-if="microCount > 1">s</span> utilisable<span v-if="microCount > 1">s</span>.</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MicrophoneCard from '../components/MicrophoneCard.vue'
const route = useRoute()
const router = useRouter()

const microCount = computed(() => parseInt(route.query.count) || 1)
const hdmiDevices = ref([])
const hdmiStream = ref(null)
const hdmiVideoEl = ref(null)

function goBack() {
  router.back()
}
function goNext() {
  router.push({
    name: 'LiveControl',
    query: {
      ...route.query
    }
  })
}

function handleKeydown(e) {
  if ((e.key === 'Enter' || e.key === ' ') && hdmiStream.value) goNext()
  if (e.key.toLowerCase() === 'r') goBack()
}

async function fetchHdmiDevicesAndStream() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')
  // Priorité aux devices Elgato (carte de capture HDMI)
  const elgato = devices.find(d => d.label && d.label.toLowerCase().includes('elgato'))
  if (elgato) {
    hdmiDevices.value = [elgato]
    await setupHdmiStream(elgato.deviceId)
  } else {
    hdmiDevices.value = []
    stopHdmiStream()
  }
}

async function setupHdmiStream(deviceId) {
  stopHdmiStream()
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

function stopHdmiStream() {
  if (hdmiStream.value) {
    hdmiStream.value.getTracks().forEach(track => track.stop())
    hdmiStream.value = null
  }
}

let hdmiPollInterval = null

onMounted(() => {
  fetchHdmiDevicesAndStream()
  hdmiPollInterval = setInterval(fetchHdmiDevicesAndStream, 2000)
  window.addEventListener('keydown', handleKeydown)
})
onBeforeUnmount(() => {
  stopHdmiStream()
  if (hdmiPollInterval) clearInterval(hdmiPollInterval)
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.camera-setup-bg {
  min-height: 100vh;
  width: 100vw;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
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
.micro-setup-grid {
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
.hdmi-card {
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
.hdmi-card.selected {
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
.camera-preview-video, .hdmi-preview-placeholder {
  width: 480px;
  height: 270px;
  border-radius: 18px;
  object-fit: cover;
  background: #000;
  margin-bottom: 0.7rem;
}
@media (max-width: 900px) {
  .camera-preview-video, .hdmi-preview-placeholder {
    width: 92vw;
    height: calc(92vw * 0.5625);
    border-radius: 10px;
  }
}
.hdmi-preview-placeholder.camera-preview-disconnected {
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
.camera-setup-actions {
  display: flex;
  flex-direction: row;
  gap: 2rem;
  justify-content: center;
  align-items: center;
  margin-bottom: 1.5rem;
}
.camera-setup-back {
  background: #fff3;
  color: #f3c300;
  border-radius: 12px;
  padding: 0.8rem 2rem;
  font-size: 1.2rem;
  font-weight: 700;
  border: none;
  cursor: pointer;
  transition: background 0.18s, color 0.18s;
  display: flex;
  align-items: center;
  gap: 0.7rem;
}
.camera-setup-back:hover {
  background: #f3c300;
  color: #0B213F;
}
.camera-setup-next {
  background: #f3c300;
  color: #0B213F;
  border-radius: 12px;
  padding: 0.8rem 2rem;
  font-size: 1.2rem;
  font-weight: 700;
  border: none;
  cursor: pointer;
  transition: background 0.18s, color 0.18s;
  display: flex;
  align-items: center;
  gap: 0.7rem;
}
.camera-setup-next:disabled {
  background: #fff3;
  color: #fff8;
  cursor: not-allowed;
}
.camera-setup-info {
  font-size: 1.1rem;
  color: #fff;
  font-weight: 400;
  margin-top: 1.5rem;
  text-align: center;
}
</style>
