<template>
  <div class="splash-bg flex flex-col items-center justify-center w-screen h-screen">
    <transition name="fade">
      <img v-if="showLogo" :src="logoSrc" alt="OneClick Hub" class="splash-logo" />
    </transition>
    <div v-if="showLoading" class="splash-loading mt-8">
      <span class="loader"></span>
      <span class="splash-text ml-4">Chargement du live...</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
const logoSrc = import.meta.env.BASE_URL + 'img/hes-logo.png'
const showLogo = ref(false)
const showLoading = ref(false)

onMounted(() => {
  showLogo.value = true
  setTimeout(() => {
    showLoading.value = true
  }, 800)
})
</script>

<style scoped>
.splash-bg {
  background: linear-gradient(135deg, #0B213F 60%, #12294b 100%);
  width: 100vw;
  height: 100vh;
  min-height: 100vh;
  min-width: 100vw;
  overflow: hidden;
  position: fixed;
  top: 0; left: 0;
  z-index: 9999;
}
.splash-logo {
  width: 220px;
  height: auto;
  filter: drop-shadow(0 8px 40px #0007);
  animation: popin 1.1s cubic-bezier(.68,-0.55,.27,1.55);
}
@keyframes popin {
  0% { transform: scale(0.6) rotate(-12deg); opacity: 0; }
  60% { transform: scale(1.08) rotate(2deg); opacity: 1; }
  100% { transform: scale(1) rotate(0deg); opacity: 1; }
}
.splash-loading {
  display: flex;
  align-items: center;
  margin-top: 2.5rem;
}
.splash-text {
  color: #fff;
  font-size: 1.2rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-shadow: 0 2px 8px #0007;
}
.loader {
  width: 28px;
  height: 28px;
  border: 4px solid #f3c300;
  border-top: 4px solid #fff0;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.7s cubic-bezier(.4,0,.2,1);
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
