<template>
  <div class="app-root-no-scroll">
    <HesLoading v-if="loading" />
    <div v-else class="p-6">
      <router-view />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import HesLoading from './components/HesLoading.vue'
const loading = ref(true)
onMounted(() => {
  setTimeout(() => {
    loading.value = false
  }, 2200) // 2.2s pour voir l'animation
})
</script>

<style>
html, body, #app, .app-root-no-scroll {
  width: 100vw;
  height: 100vh;
  margin: 0;
  padding: 0;
  overflow: hidden !important;
  background: transparent;
}
body {
  background: transparent !important;
}
</style>
