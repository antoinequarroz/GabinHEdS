<template>
  <div class="microphone-card" :class="{ 'active': soundOk }">
    <div class="microphone-card-header">
      <img class="microphone-img" :src="micImgSrc" alt="Micro podcast" />
      <span class="microphone-card-title">Micro {{ index + 1 }}</span>
    </div>
    <div class="microphone-card-label">{{ label || 'Microphone' }}</div>
    <div class="microphone-vu-meter">
      <div class="microphone-vu-bar" :style="{height: level + '%'}"></div>
    </div>
    <span v-if="soundOk" class="microphone-sound-ok">Son OK</span>
    <span v-else class="microphone-sound-error">Pas de son</span>
  </div>
</template>

<script setup>
const micImgSrc = import.meta.env.BASE_URL + 'img/podcast.png'
defineProps({
  label: String,
  level: Number,
  soundOk: Boolean,
  index: Number
})
</script>

<style scoped>
.microphone-card {
  width: 440px;
  min-height: 440px;
  background: linear-gradient(135deg, #202e4a 0%, #14213d 100%);
  border-radius: 2.7rem;
  box-shadow: 0 12px 44px 0 #0B213F55, 0 4px 16px #f3c30033;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2.8rem 2.2rem 2.2rem 2.2rem;
  position: relative;
  transition: box-shadow 0.18s, border 0.18s, background 0.18s;
  border: 3.5px solid transparent;
}
.microphone-card.active {
  border: 3.5px solid #4caf50;
  box-shadow: 0 10px 40px 0 #4caf5099, 0 2px 8px #fff2;
}
.microphone-card-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  font-size: 2.7rem;
  color: #fff;
  margin-bottom: 1.3rem;
  width: 100%;
}
.microphone-img {
  width: 120px;
  height: 120px;
  object-fit: contain;
  display: block;
  margin: 0 auto 0.7rem auto;
}
.microphone-card-title {
  font-size: 2.2rem;
  font-weight: 900;
  color: #fff;
  text-align: center;
  margin-top: 0.5rem;
}
.microphone-card-label {
  font-size: 1.4rem;
  color: #fff;
  margin-bottom: 1.6rem;
  text-align: center;
}
.microphone-vu-meter {
  width: 54px;
  height: 170px;
  background: #111;
  border-radius: 18px;
  margin-bottom: 1.1rem;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  margin-left: auto;
  margin-right: auto;
}
.microphone-vu-bar {
  width: 100%;
  background: linear-gradient(180deg, #4caf50 0%, #ffeb3b 60%, #f44336 100%);
  transition: height 0.15s;
}
.microphone-sound-ok {
  color: #4caf50;
  font-weight: bold;
  margin-top: 0.7rem;
  font-size: 1.2rem;
  text-align: center;
}
.microphone-sound-error {
  color: #f44336;
  font-weight: bold;
  margin-top: 0.7rem;
  font-size: 1.2rem;
  text-align: center;
}

.mic-list {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 3.5rem;
  width: 100vw;
  min-height: 70vh;
}

.podcast-container {
  min-height: 100vh;
  min-width: 100vw;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(13, 31, 63, 0.97);
  padding: 0;
}

.podcast-header {
  margin-top: 2.5rem;
}
</style>
