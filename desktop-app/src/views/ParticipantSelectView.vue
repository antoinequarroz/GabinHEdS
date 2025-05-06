<template>
  <div class="participant-onboarding-bg">
    <div class="participant-onboarding-container">
      <h1 class="page-title">Sélectionner les intervenants</h1>
      <div class="page-subtitle">Choisissez le nombre d'intervenants qui participeront à la session</div>
      <div class="participant-onboarding-grid">
        <ParticipantCard
          v-for="(p, idx) in participants"
          :key="idx"
          :name="p.name"
          :image="p.image"
          :selected="selectedIdx === idx"
          :number="idx + 1"
          :color="colors[idx]"
          @select="() => selectParticipant(idx)"
        >
          <template #footer>
            <div v-if="!profileForKey(p.profileKey)" class="participant-disabled">(bientôt disponible)</div>
          </template>
        </ParticipantCard>
      </div>
      <div class="participant-onboarding-actions">
        <button class="participant-onboarding-back" @click="goBack">
          <i class="pi pi-arrow-left"></i> Retour
        </button>
        <button class="participant-onboarding-next" :disabled="selectedIdx === null" @click="confirmSelection">
          Continuer <i class="pi pi-arrow-right"></i>
        </button>
      </div>
      <div class="participant-onboarding-help">
        Ensuite, continuez <i class="pi pi-arrow-right"></i>
      </div>
    </div>
    <transition name="fade-pop">
      <div v-if="showConfirmation" class="participant-confirm-overlay">
        <div class="participant-confirm-content">
          <i class="pi pi-check-circle participant-confirm-icon"></i>
          <div class="participant-confirm-title">Participant sélectionné !</div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRouter } from 'vue-router'
import ParticipantCard from '../components/ParticipantCard.vue'
import { profiles, applyProfile } from '@/profiles'

const router = useRouter()
const participants = ref([
  { name: 'Intervenant', image: import.meta.env.BASE_URL + 'img/1intervenantsImg.png', profileKey: '1 Intervenant' },
  { name: 'Intervenants', image: import.meta.env.BASE_URL + 'img/2intervenantsImg.png', profileKey: '2 Intervenants' },
  { name: 'Intervenants', image: import.meta.env.BASE_URL + 'img/3intervenantsImg.png', profileKey: '3 Intervenants' },
  { name: 'Intervenants', image: import.meta.env.BASE_URL + 'img/4intervenantsImg.png', profileKey: '4 Intervenants' }
])

const colors = [
  '#E53935', // Rouge
  '#1E88E5', // Bleu
  '#43A047', // Vert
  '#FDD835', // Jaune
]
const selectedIdx = ref(null)
const showConfirmation = ref(false)

const profileForKey = key => profiles.find(p => p.name.includes(key))

function selectParticipant(idx) {
  selectedIdx.value = idx
  const participant = participants.value[idx]
  const profile = profileForKey(participant.profileKey)
  if (profile) applyProfile(profile)
}

function confirmSelection() {
  if (selectedIdx.value === null) return
  showConfirmation.value = true
  setTimeout(() => {
    showConfirmation.value = false
    // Redirige vers la vue de positionnement après la sélection
    router.push({
      name: 'ParticipantPosition',
      query: {
        ...router.currentRoute.value.query,
        count: selectedIdx.value + 1
      }
    })
  }, 1000)
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

function handleKeydown(e) {
  if ((e.key === 'Enter' || e.key === ' ') && selectedIdx.value !== null) confirmSelection()
  if (e.key.toLowerCase() === 'r') goBack()
  if (['1','2','3','4'].includes(e.key)) {
    const idx = parseInt(e.key, 10) - 1
    if (participants.value[idx]) selectParticipant(idx)
  }
}
</script>

<style scoped>
.participant-onboarding-bg {
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
}
.participant-onboarding-container {
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
.participant-onboarding-grid {
  display: flex;
  flex-direction: row;
  gap: 48px;
  justify-content: center;
  align-items: stretch;
  margin-bottom: 2.5rem;
}
.participant-onboarding-actions {
  display: flex;
  flex-direction: row;
  gap: 2rem;
  justify-content: center;
  align-items: center;
  margin-bottom: 1.5rem;
}
.participant-onboarding-back, .participant-onboarding-next {
  background: #0B213F;
  color: #fff;
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
.participant-onboarding-back {
  background: #fff3;
  color: #f3c300;
}
.participant-onboarding-back:hover {
  background: #f3c300;
  color: #0B213F;
}
.participant-onboarding-next {
  background: #f3c300;
  color: #0B213F;
}
.participant-onboarding-next:disabled {
  background: #fff3;
  color: #fff8;
  cursor: not-allowed;
}
.participant-onboarding-help {
  color: #fff;
  font-size: 1.1rem;
  margin-top: 2.2rem;
  text-align: center;
  opacity: 0.92;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  justify-content: center;
}
.participant-confirm-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(11,33,63,0.86);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.participant-confirm-content {
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
.participant-confirm-icon {
  font-size: 5.5rem;
  color: #f3c300;
  margin-bottom: 1.5rem;
}
.participant-confirm-title {
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
.participant-disabled {
  color: #ffd600;
  font-size: 0.9rem;
  margin-top: 0.5rem;
  opacity: 0.7;
  text-align: center;
}
@media (max-width: 900px) {
  .participant-onboarding-grid {
    flex-direction: column;
    gap: 32px;
    width: 100vw;
    max-width: 98vw;
  }
  .participant-onboarding-container {
    padding: 0;
  }
}
</style>
