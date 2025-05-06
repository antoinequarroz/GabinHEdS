<template>
  <div class="modality-onboarding-bg">
    <div class="modality-onboarding-container">
      <h1 class="page-title">Choisir le type de modalité</h1>
      <div class="page-subtitle">Sélectionnez le format de votre enregistrement (podcast, interview, etc.)</div>
      <div class="modality-onboarding-grid">
        <ModalityCard
          title="Podcast"
          desc="Créer votre podcast"
          :image="podcastImgSrc"
          :selected="selected === 'podcast'"
          @select="selected = 'podcast'"
        />
        <ModalityCard
          title="Powerpoint sonorisé"
          desc="Créer votre présentation"
          :image="powerpointImgSrc"
          :selected="selected === 'powerpoint'"
          @select="selected = 'powerpoint'"
        />
        <ModalityCard
          title="Table ronde"
          desc="Enregistrer une table ronde"
          :image="roundtableImgSrc"
          :selected="selected === 'roundtable'"
          @select="selected = 'roundtable'"
        />
      </div>
      <button class="modality-onboarding-next" :disabled="!selected" @click="confirmSelection">
        Ensuite, continuez <i class="pi pi-arrow-right"></i>
      </button>
    </div>
    <transition name="fade-pop">
      <div v-if="showConfirmation" class="modality-confirm-overlay">
        <div class="modality-confirm-content">
          <i class="pi pi-check-circle modality-confirm-icon"></i>
          <div class="modality-confirm-title">{{ confirmationMessage }}</div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import ModalityCard from '../components/ModalityCard.vue'
const router = useRouter()
const selected = ref('')
const showConfirmation = ref(false)
const confirmationMessage = ref('')
const podcastImgSrc = import.meta.env.BASE_URL + 'img/podcast.png'
const powerpointImgSrc = import.meta.env.BASE_URL + 'img/powerpoints.png'
const roundtableImgSrc = import.meta.env.BASE_URL + 'img/roundtable.png'

function confirmSelection() {
  if (!selected.value) return
  confirmationMessage.value =
    selected.value === 'podcast' ? 'Podcast sélectionné !' :
    selected.value === 'powerpoint' ? 'Powerpoint sonorisé sélectionné !' :
    selected.value === 'roundtable' ? 'Table ronde sélectionnée !' : ''
  showConfirmation.value = true
  setTimeout(() => {
    showConfirmation.value = false
    if (selected.value === 'powerpoint') {
      router.push({ name: 'CameraOptionSelect', query: { modality: selected.value } })
    } else {
      router.push({ name: 'ParticipantSelect', query: { modality: selected.value } })
    }
  }, 2000)
}

function handleKeydown(e) {
  if ((e.key === 'Enter' || e.key === ' ') && selected.value) confirmSelection()
  if (e.key.toLowerCase() === 'r') goBack()
  if (e.key === '1') selected.value = 'podcast'
  if (e.key === '2') selected.value = 'powerpoint'
  if (e.key === '3') selected.value = 'roundtable'
}

function goBack() {
  router.back()
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.modality-onboarding-bg {
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
}
.modality-onboarding-container {
  width: 100vw;
  height: 100vh;
  max-width: 100vw;
  max-height: 100vh;
  background: rgba(13, 31, 63, 0.97);
  border-radius: 0;
  padding: 0;
  box-shadow: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
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
.modality-onboarding-title {
  color: #fff;
  font-size: 2.3rem;
  font-weight: 700;
  margin-bottom: 2.5rem;
  text-align: center;
  letter-spacing: 0.02em;
}
.modality-onboarding-grid {
  display: flex;
  flex-direction: row;
  gap: 48px;
  justify-content: center;
  align-items: stretch;
  margin-bottom: 2.5rem;
}
.modality-onboarding-next {
  background: #f3c300;
  color: #0B213F;
  font-size: 1.2rem;
  font-weight: 700;
  border-radius: 18px;
  border: none;
  padding: 1rem 2.2rem;
  cursor: pointer;
  box-shadow: 0 2px 16px #f3c30044;
  transition: background 0.18s, color 0.18s;
  display: flex;
  align-items: center;
  gap: 0.7rem;
}
.modality-onboarding-next:disabled {
  background: #fff3;
  color: #fff8;
  cursor: not-allowed;
}
.modality-confirm-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(11,33,63,0.86);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modality-confirm-content {
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  color: #fff;
  padding: 3.5rem 4.5rem;
  border-radius: 38px;
  box-shadow: 0 8px 60px #0B213F33;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2.2rem;
}
.modality-confirm-icon {
  font-size: 5.5rem;
  color: #f3c300;
  margin-bottom: 1.5rem;
}
.modality-confirm-title {
  font-size: 2.7rem;
  font-weight: 900;
  text-align: center;
}
.fade-pop-enter-active, .fade-pop-leave-active {
  transition: opacity 0.4s, transform 0.4s;
}
.fade-pop-enter-from, .fade-pop-leave-to {
  opacity: 0;
  transform: scale(0.8);
}
@media (max-width: 900px) {
  .modality-onboarding-grid {
    flex-direction: column;
    gap: 32px;
    width: 100vw;
    max-width: 98vw;
  }
  .modality-onboarding-container {
    padding: 0;
  }
}
</style>
