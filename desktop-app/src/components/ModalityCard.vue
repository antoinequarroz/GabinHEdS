<template>
  <div class="modality-card-beautiful" :class="{ selected }" @click="$emit('select')">
    <div class="modality-card-center">
      <div class="modality-image-wrapper" v-if="image">
        <img :src="image" :alt="title" class="modality-image" />
      </div>
      <div v-else class="modality-icon-wrapper">
        <i :class="icon" />
      </div>
      <div class="modality-title">{{ title }}</div>
      <div class="modality-desc">{{ desc }}</div>
    </div>
    <transition name="fade-pop">
      <div v-if="selected" class="modality-selected-badge">
        <i class="pi pi-check-circle" />
      </div>
    </transition>
  </div>
</template>

<script setup>
defineProps({
  title: String,
  desc: String,
  icon: String,
  image: String,
  selected: Boolean
})
</script>

<style scoped>
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
.modality-card-beautiful.selected {
  border: 3.5px solid #f3c300;
  box-shadow: 0 14px 60px 0 #f3c30099, 0 4px 18px #fff2;
  animation: card-pop 0.22s cubic-bezier(.4,2,.6,1) 1;
}
@keyframes card-pop {
  0% { transform: scale(1); }
  60% { transform: scale(1.09); }
  100% { transform: scale(1.04); }
}
.modality-card-beautiful:hover {
  box-shadow: 0 14px 60px 0 #f3c30099, 0 4px 18px #fff2;
  border: 3.5px solid #f3c300;
  transform: translateY(-10px) scale(1.06);

}
.modality-card-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  height: 100%;
  padding: 3.2rem 2.2rem 2.2rem 2.2rem;
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
.modality-icon-wrapper {
  background: #fff3;
  border-radius: 32px;
  padding: 3.2rem 3.6rem;
  margin-bottom: 2.8rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 6rem;
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
.modality-desc {
  font-size: 1.9rem;
  color: #f3c300;
  text-align: center;
  font-weight: 700;
  opacity: 0.97;
  margin-bottom: 0.7rem;
  word-break: break-word;
  white-space: normal;
}
.modality-selected-badge {
  position: absolute;
  top: 32px;
  right: 40px;
  background: #f3c300;
  color: #0B213F;
  border-radius: 50%;
  padding: 0.7rem 0.8rem;
  font-size: 2.2rem;
  box-shadow: 0 3px 12px #0002;
  z-index: 2;
  height: 40px;
  width: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.fade-pop-enter-active, .fade-pop-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}
.fade-pop-enter-from, .fade-pop-leave-to {
  opacity: 0;
  transform: scale(0.7);
}
</style>
