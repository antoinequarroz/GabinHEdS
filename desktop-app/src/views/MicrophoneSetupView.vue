<template>
  <div class="micro-setup-bg">
    <div class="micro-setup-container">
      <h2 class="micro-setup-title">Configuration des micros</h2>
      <div class="micro-setup-grid" :class="`micros-${microCount}`">
        <div v-for="n in microCount" :key="n" class="micro-setup-card">
          <div class="micro-setup-card-inner">
            <i class="pi pi-microphone micro-setup-icon"></i>
            <div class="micro-setup-label">Micro {{ n }}</div>
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
        <span>{{ microCount }} micro<span v-if="microCount > 1">s</span> utilisable<span v-if="microCount > 1">s</span> pour {{ participantCount }} participant<span v-if="participantCount > 1">s</span>.</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
const route = useRoute()
const router = useRouter()
function goBack() {
  router.back()
}
function goToPodcast() {
  // On passe le nombre de micros/personnes en query param
  router.push({ name: 'Podcast', query: { count: microCount.value } })
}
const participantCount = computed(() => parseInt(route.query.count) || 1)
const microCount = computed(() => participantCount.value)
</script>

<style scoped>
.micro-setup-bg {
  min-height: 100vh;
  width: 100vw;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  display: flex;
  align-items: center;
  justify-content: center;
}
.micro-setup-container {
  background: rgba(13, 31, 63, 0.97);
  border-radius: 32px;
  padding: 3.5rem 5rem 2.5rem 5rem;
  box-shadow: 0 8px 60px #0B213F33;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2.5rem;
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
  gap: 48px;
  justify-content: center;
  align-items: stretch;
  margin-bottom: 2.5rem;
}
.micro-setup-card {
  background: linear-gradient(135deg, #223b6b 0%, #0B213F 100%);
  border-radius: 24px;
  box-shadow: 0 4px 24px #0B213F33;
  width: 220px;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}
.micro-setup-card-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.2rem;
}
.micro-setup-icon {
  font-size: 3.5rem;
  color: #f3c300;
  margin-bottom: 0.5rem;
}
.micro-setup-label {
  font-size: 1.3rem;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.01em;
}
.micro-setup-info {
  color: #fff;
  font-size: 1.1rem;
  margin-top: 1.2rem;
  text-align: center;
  opacity: 0.92;
}
.micros-2 .micro-setup-card { width: 260px; }
.micros-3 .micro-setup-card, .micros-4 .micro-setup-card { width: 200px; }
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
@media (max-width: 900px) {
  .micro-setup-grid {
    flex-direction: column;
    gap: 32px;
    width: 100vw;
    max-width: 98vw;
  }
  .micro-setup-container {
    padding: 1.5rem 0.5rem;
  }
}
</style>
