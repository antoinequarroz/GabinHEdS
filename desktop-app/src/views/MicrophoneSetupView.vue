<template>
  <div class="micro-setup-bg">
    <h1 class="page-title">Configurer le micro</h1>
    <div class="page-subtitle">Testez et ajustez le volume sonore avant d'enregistrer</div>
    <div class="micro-setup-grid" :class="`micros-${microCount}`">
      <div v-for="n in microCount" :key="n" class="modality-card-beautiful micro-setup-card">
        <div class="modality-card-center">
          <div class="modality-image-wrapper">
            <img :src="imgSrc" alt="Microphone" class="modality-image" />
          </div>
          <div class="modality-title">Micro {{ n }}</div>
        </div>
      </div>
    </div>
    <div class="micro-setup-actions">
      <button class="micro-setup-back" @click="goBack">
        <i class="pi pi-arrow-left"></i> Retour
      </button>
      <button class="micro-setup-next" @click="goToPodcast">
        Continuer <i class="pi pi-arrow-right"></i>
      </button>
    </div>
    <div class="micro-setup-info">
      <span>{{ microCount }} micro<span v-if="microCount > 1">s</span> utilisable<span v-if="microCount > 1">s</span>.</span>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
const route = useRoute()
const router = useRouter()
const imgSrc = import.meta.env.BASE_URL + 'img/podcast.png'
const nextDisabled = ref(false)

function goBack() {
  router.back()
}
function goToPodcast() {
  // On passe le nombre de micros en query param
  router.push({ name: 'Podcast', query: { count: microCount.value } })
}
const microCount = computed(() => parseInt(route.query.count) || 1)

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
})

function handleKeydown(e) {
  if (e.key === 'Enter' || e.key === ' ') goToPodcast()
  if (e.key.toLowerCase() === 'r') goBack()
}
</script>

<style scoped>
.micro-setup-bg {
  min-height: 100vh;
  width: 100vw;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
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
.micro-setup-title {
  color: #fff;
  font-size: 2.3rem;
  font-weight: 700;
  margin-bottom: 2.5rem;
  text-align: center;
  letter-spacing: 0.02em;
}
.micro-setup-grid {
  display: flex;
  gap: 96px;
  justify-content: center;
  align-items: stretch;
  margin-bottom: 2.5rem;
  width: 100vw;
  max-width: 100vw;
  overflow-x: auto;
}
.micro-setup-actions {
  display: flex;
  flex-direction: row;
  gap: 2rem;
  justify-content: center;
  align-items: center;
  margin-bottom: 1.5rem;
}
.micro-setup-back, .micro-setup-next {
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
.micro-setup-back {
  background: #fff3;
  color: #f3c300;
}
.micro-setup-back:hover {
  background: #f3c300;
  color: #0B213F;
}
.micro-setup-next {
  background: #f3c300;
  color: #0B213F;
}
.micro-setup-next:disabled {
  background: #fff3;
  color: #fff8;
  cursor: not-allowed;
}
.micro-setup-info {
  color: #fff;
  font-size: 1.1rem;
  margin-top: 1.2rem;
  text-align: center;
  opacity: 0.92;
}
/* --- ModalityCard style for beautiful cards --- */
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
.modality-card-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  height: 100%;
  padding: 2.2rem 1.5rem 1.5rem 1.5rem;
  box-sizing: border-box;
}
.modality-image-wrapper {
  width: 100%;
  height: 210px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 2.8rem;
  background: none;
  box-shadow: none;
  border-radius: 0;
  overflow: visible;
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
  font-size: 3.2rem;
  font-weight: 900;
  color: #fff;
  text-align: center;
  margin-bottom: 1.4rem;
  letter-spacing: 0.01em;
  line-height: 1.1;
  word-break: break-word;
  white-space: normal;
}
@media (max-width: 900px) {
  .micro-setup-grid {
    flex-direction: column;
    gap: 32px;
    width: 100vw;
    max-width: 98vw;
  }
}
</style>
