<template>
  <div class="video-player-container">
    <video
      v-if="!isHls || hlsSupported"
      ref="videoRef"
      :src="!isHls ? src : undefined"
      controls
      autoplay
      class="video-player"
      :poster="poster"
    />
    <div v-else class="video-player-error">
      Impossible d'afficher ce flux vidéo.
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
let Hls = null

const props = defineProps({
  src: { type: String, required: true },
  poster: String
})
const videoRef = ref(null)
const isHls = props.src.endsWith('.m3u8')
const hlsSupported = ref(true)
let hlsInstance = null

onMounted(async () => {
  if (isHls) {
    if (!window.Hls) {
      Hls = (await import('hls.js')).default
      window.Hls = Hls
    } else {
      Hls = window.Hls
    }
    if (Hls.isSupported()) {
      hlsInstance = new Hls()
      hlsInstance.loadSource(props.src)
      hlsInstance.attachMedia(videoRef.value)
    } else if (videoRef.value.canPlayType('application/vnd.apple.mpegurl')) {
      videoRef.value.src = props.src
    } else {
      hlsSupported.value = false
    }
  }
})
onBeforeUnmount(() => {
  if (hlsInstance) {
    hlsInstance.destroy()
    hlsInstance = null
  }
})
watch(() => props.src, (newSrc) => {
  if (isHls && hlsInstance) {
    hlsInstance.loadSource(newSrc)
  } else if (!isHls && videoRef.value) {
    videoRef.value.src = newSrc
  }
})
</script>

<style scoped>
.video-player-container {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  border-radius: 18px;
  overflow: hidden;
}
.video-player {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
}
.video-player-error {
  color: #fff;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  padding: 2rem;
  border-radius: 18px;
  font-size: 1.2rem;
  text-align: center;
}
</style>
