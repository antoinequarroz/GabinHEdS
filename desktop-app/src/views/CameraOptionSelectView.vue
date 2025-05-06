<template>
  <div class="camera-option-bg">
    <h1 class="page-title">Choisir la modalité d'enregistrement</h1>
    <div class="page-subtitle">Souhaitez-vous enregistrer votre PowerPoint avec ou sans caméra ?</div>
    <div class="camera-option-grid">
      <div
        class="modality-card-beautiful"
        :class="{ selected: selected === 1 }"
        @click="selectOption(1)"
        tabindex="0"
      >
        <div class="modality-card-center">
          <div class="modality-image-wrapper">
            <img :src="cameraImgSrc" alt="Avec caméra" class="modality-image" />
          </div>
          <div class="modality-title">Avec caméra</div>
          <div class="modality-desc">Vidéo + audio, configuration caméra requise</div>
        </div>
        <transition name="fade-pop">
          <div v-if="selected === 1" class="modality-selected-badge">
            <i class="pi pi-check-circle" />
          </div>
        </transition>
      </div>
      <div
        class="modality-card-beautiful"
        :class="{ selected: selected === 2 }"
        @click="selectOption(2)"
        tabindex="0"
      >
        <div class="modality-card-center">
          <div class="modality-image-wrapper">
            <img :src="cameraImgSrc1" alt="Sans caméra" class="modality-image" />
          </div>
          <div class="modality-title">Sans caméra</div>
          <div class="modality-desc">Audio uniquement, pas de vidéo ni configuration caméra</div>
        </div>
        <transition name="fade-pop">
          <div v-if="selected === 2" class="modality-selected-badge">
            <i class="pi pi-check-circle" />
          </div>
        </transition>
      </div>
    </div>
    <div class="camera-option-actions">
      <button class="camera-btn camera-btn-back" @click="goBack">
        <i class="pi pi-arrow-left"></i> Retour
      </button>
      <button class="camera-btn camera-btn-next" :disabled="!selected" @click="goNext">
        Continuer <i class="pi pi-arrow-right"></i>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute } from 'vue-router'
const router = useRouter()
const route = useRoute()

const selected = ref(null)
const cameraImgSrc = import.meta.env.BASE_URL + 'img/CameraG.png'
const cameraImgSrc1 = import.meta.env.BASE_URL + 'img/CameraD.png'

function selectOption(val) {
  selected.value = val
}

function goNext() {
  if (selected.value === null) return
  if (selected.value === 1) {
    router.push({
      name: 'ParticipantSelect',
      query: {
        ...route.query,
        withCamera: '1',
        modality: 'powerpoint'
      }
    })
  } else {
    router.push({
      name: 'ParticipantSelect',
      query: {
        ...route.query,
        withCamera: '0',
        modality: 'powerpoint'
      }
    })
  }
}

function goBack() {
  router.back()
}

function handleKeydown(e) {
  if (e.key === '1') {
    selected.value = 1
  }
  if (e.key === '2') {
    selected.value = 2
  }
  if ((e.key === 'Enter' || e.key === ' ') && selected.value) {
    goNext()
  }
  if (e.key.toLowerCase() === 'r') {
    goBack()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.camera-option-bg {
  min-height: 100vh;
  background: #0B213F;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.page-title {
  font-size: 2.4rem;
  font-weight: 900;
  color: #f3c300;
  margin-bottom: 0.3em;
  letter-spacing: 1px;
  text-align: center;
}
.page-subtitle {
  font-size: 1.25rem;
  color: #fff;
  font-weight: 400;
  margin-bottom: 2em;
  text-align: center;
  opacity: 0.88;
}
.camera-option-grid {
  display: flex;
  gap: 2.5rem;
}
.camera-option-actions {
  display: flex;
  justify-content: center;
  gap: 2.5rem;
  margin-top: 2.5rem;
}
.camera-btn {
  background: #fff;
  color: #0B213F;
  font-weight: 700;
  font-size: 1.18rem;
  border-radius: 16px;
  border: none;
  padding: 0.85em 2.2em;
  box-shadow: 0 2px 14px #0B213F22;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.7em;
  transition: background 0.15s, color 0.15s;
}
.camera-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.camera-btn-back {
  background: #e6e6e6;
  color: #0B213F;
}
.camera-btn-next {
  background: #f3c300;
  color: #0B213F;
}
@import '../components/ModalityCard.vue';

.modality-card-beautiful {
  aspect-ratio: unset;
  width: 420px;
  min-height: 420px;
  max-width: 480px;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%),
    radial-gradient(circle at 60% 30%, #25477a33 0%, #0B213F00 80%);
  border-radius: 38px;
  box-shadow: 0 10px 60px 0 #0B213F44, 0 2px 14px #f3c30033;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: box-shadow 0.18s, transform 0.18s, border 0.18s;
  border: 3.5px solid transparent;
  position: relative;
  overflow: hidden;
  flex-direction: column;
}
.modality-card-beautiful.selected {
  border: 3.5px solid #f3c300;
  box-shadow: 0 14px 60px 0 #f3c30099, 0 4px 18px #fff2;
  animation: card-pop 0.22s cubic-bezier(.4,2,.6,1) 1;
}
@keyframes card-pop {
  0% { transform: scale(1); }
  60% { transform: scale(1.09); }
  100% { transform: scale(1.04); }
}
.modality-card-beautiful:hover {
  box-shadow: 0 16px 60px 0 #f3c300dd, 0 4px 18px #fff2;
  border: 3.5px solid #f3c300;
}
.modality-card-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 0 1.5rem;
}
.modality-image-wrapper {
  margin-bottom: 1.5rem;
}
.modality-image {
  width: 200px;
  height: 200px;
  object-fit: contain;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.modality-title {
  font-size: 2.1rem;
  font-weight: 900;
  color: #fff;
  margin-bottom: 0.7rem;
  letter-spacing: 1px;
  text-align: center;
}
.modality-desc {
  font-size: 1.18rem;
  color: #f7f7f7;
  font-weight: 400;
  text-align: center;
  margin-bottom: 0.5rem;
}
.modality-selected-badge {
  position: absolute;
  top: 32px;
  right: 40px;
  background: #f3c300;
  color: #0B213F;
  border-radius: 50%;
  padding: 0.7rem 0.8rem;
  font-size: 2.2rem;
  box-shadow: 0 3px 12px #0002;
  z-index: 2;
  height: 40px;
  width: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
