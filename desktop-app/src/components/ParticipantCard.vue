<template>
  <div class="participant-card-beautiful" :class="{ selected }" @click="$emit('select')">
    <div class="participant-card-center">
      <div class="participant-image-wrapper">
        <img v-if="image" :src="image" :alt="name" class="participant-image" />
        <i v-else class="pi pi-user participant-avatar"></i>
      </div>
      <div class="participant-name">{{ name }}</div>
    </div>
    <transition name="fade-pop">
      <div v-if="selected" class="participant-selected-badge">
        <i class="pi pi-check"></i>
      </div>
    </transition>
  </div>
</template>

<script setup>
defineProps({
  name: String,
  image: String,
  selected: Boolean
})
</script>

<style scoped>
.participant-card-beautiful {
  width: 320px;
  min-height: 240px;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  border-radius: 32px;
  box-shadow: 0 6px 40px 0 #0B213F44, 0 1.5px 8px #f3c30033;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: box-shadow 0.18s, transform 0.18s, border 0.18s;
  border: 2.5px solid transparent;
  position: relative;
  overflow: hidden;
  flex-direction: column;
}
.participant-card-beautiful.selected {
  border: 2.5px solid #f3c300;
  box-shadow: 0 8px 40px 0 #f3c30099, 0 2px 12px #fff2;
  animation: card-pop 0.22s cubic-bezier(.4,2,.6,1) 1;
}
@keyframes card-pop {
  0% { transform: scale(1); }
  60% { transform: scale(1.09); }
  100% { transform: scale(1.04); }
}
.participant-card-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  height: 100%;
  padding: 2.2rem 1.5rem 1.5rem 1.5rem;
  box-sizing: border-box;
}
.participant-image-wrapper {
  width: 100px;
  height: 100px;
  border-radius: 22px;
  background: #fff6;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 1.2rem;
  overflow: hidden;
  box-shadow: 0 2px 18px #0001;
}
.participant-image {
  width: 90px;
  height: 90px;
  object-fit: cover;
  border-radius: 16px;
  background: #fff;
}
.participant-avatar {
  font-size: 3.5rem;
  color: #0B213F;
}
.participant-name {
  font-size: 1.5rem;
  font-weight: 700;
  color: #fff;
  text-align: center;
  margin-bottom: 0.3rem;
  letter-spacing: 0.01em;
  line-height: 1.1;
  word-break: break-word;
  white-space: normal;
}
.participant-selected-badge {
  position: absolute;
  top: 18px;
  right: 24px;
  background: #f3c300;
  color: #0B213F;
  border-radius: 50%;
  padding: 0.5rem 0.6rem;
  font-size: 1.7rem;
  box-shadow: 0 2px 8px #0002;
  z-index: 2;
  height: 32px;
  width: 32px;
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
