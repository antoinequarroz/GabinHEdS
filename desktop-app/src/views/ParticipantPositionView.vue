<template>
  <div class="positioning-bg">
    <h2 class="positioning-title">Positionnement des intervenants</h2>
    <div class="positioning-img-container">
      <img :src="positionImage" :alt="`Positionnement ${participantCount} intervenant(s)`" class="positioning-img" />
    </div>
    <div class="positioning-legend">
      <div v-for="(color, idx) in colors.slice(0, participantCount)" :key="'legend-'+idx" class="legend-item">
        <span class="seat-dot" :style="{ backgroundColor: color }"></span>
        <span>{{ seatLabels[idx] }}</span>
      </div>
    </div>
    <div class="positioning-actions">
      <button class="positioning-back" @click="goBack">Retour</button>
      <button class="positioning-next" @click="goNext">Continuer</button>
    </div>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { computed } from 'vue'
const router = useRouter()
const colors = [
  '#E53935', // Rouge
  '#1E88E5', // Bleu
  '#43A047', // Vert
  '#F3C300'  // Jaune
]
const seatLabels = ['Intervenant 1', 'Intervenant 2', 'Intervenant 3', 'Intervenant 4']

// Déterminer le nombre d'intervenants depuis les query params
const participantCount = computed(() => {
  // On récupère count depuis la query, sinon 4 par défaut
  const count = parseInt(router.currentRoute.value.query.count)
  return (count >= 1 && count <= 4) ? count : 4
})
const positionImage = computed(() => {
  return `${import.meta.env.BASE_URL}img/${participantCount.value}intervenantsPosition.png`
})

function goNext() {
  // Redirige selon la modalité
  const modality = router.currentRoute.value.query.modality
  if (modality === 'podcast') {
    router.push({ name: 'MicrophoneSetup', query: router.currentRoute.value.query })
  } else {
    router.push({ name: 'CameraSetup', query: router.currentRoute.value.query })
  }
}
function goBack() {
  router.back()
}
</script>

<style scoped>
.positioning-bg {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #0B213F;
  color: #fff;
}
.positioning-title {
  font-size: 2.3rem;
  margin-bottom: 24px;
  font-weight: 700;
}
.positioning-img-container {
  width: 780px;
  height: 560px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #12294b;
  border-radius: 30px 30px 60px 60px;
  box-shadow: 0 4px 32px #0005;
  margin-bottom: 32px;
}
.positioning-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.positioning-legend {
  display: flex;
  gap: 18px;
  margin-bottom: 24px;
  justify-content: center;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 1.1rem;
}
.seat-dot {
  width: 22px;
  height: 22px;
  border-radius: 8px;
  vertical-align: middle;
  box-shadow: 0 2px 8px #0002;
  border: 2px solid #fff5;
}
.positioning-actions {
  display: flex;
  gap: 18px;
  justify-content: center;
}
.positioning-back {
  background: #1e335c;
  color: #fff;
  border: none;
  border-radius: 12px;
  padding: 12px 34px;
  font-size: 1.3rem;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 2px 12px #0003;
  transition: background 0.18s;
}
.positioning-back:hover {
  background: #25477a;
}
.positioning-next {
  background: #f3c300;
  color: #12294b;
  border: none;
  border-radius: 12px;
  padding: 12px 34px;
  font-size: 1.3rem;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 2px 12px #0003;
  transition: background 0.18s;
}
.positioning-next:hover {
  background: #ffe066;
}
</style>
