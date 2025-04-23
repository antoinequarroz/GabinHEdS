<template>
  <div class="w-screen h-screen bg-black flex items-center justify-center">
    <LogoSplash v-if="showSplash" />
    <VideoPlayer v-else-if="videoUrl" :src="videoUrl" :poster="poster" />
    <div v-else class="text-white text-2xl">Aucun flux vidéo disponible</div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import VideoPlayer from '../components/VideoPlayer.vue'
import LogoSplash from '../components/LogoSplash.vue'

// À remplacer par l'URL réelle du flux (HLS, MP4, etc.)
const videoUrl = ref('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8') // exemple HLS
const poster = ''
const showSplash = ref(true)

onMounted(() => {
  setTimeout(() => {
    showSplash.value = false
  }, 2200) // Splash visible ~2s
})
</script>

<style scoped>
body, html, #app {
  background: #000;
  margin: 0;
  padding: 0;
}
</style>
