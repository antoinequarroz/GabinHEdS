<template>
  <div class="hes-loading-bg">
    <div class="hes-loading-center">
      <img
        :src="logoSrc"
        class="hes-logo-spin"
        alt="Logo HES"
      />
      <span class="hes-loading-spinner"></span>
      <div class="hes-loading-text">Chargement…</div>
    </div>
  </div>
</template>

<script setup>
const logoSrc = import.meta.env.BASE_URL + 'img/hes-logo.png'
</script>

<style scoped>
.hes-loading-bg {
  width: 100vw;
  height: 100vh;
  background: linear-gradient(135deg, #1e335c 0%, #12294b 60%, #0B213F 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  position: fixed;
  left: 0; top: 0;
  z-index: 9999;
}
.hes-loading-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2.5rem;
}
.hes-logo-spin {
  width: auto;
  height: 180px;

}
.hes-loading-spinner {
  width: 60px;
  height: 60px;
  margin-top: 1.2rem;
  border: 5px solid #f3c30044;
  border-top: 5px solid #f3c300;
  border-radius: 50%;
  animation: hes-spinner-rotate 1.1s linear infinite;
  z-index: 1;
  display: block;
}
@keyframes hes-spinner-rotate {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes hes-spin {
  0% { transform: scale(1) rotate(-5deg); }
  50% { transform: scale(1.08) rotate(5deg); }
  100% { transform: scale(1) rotate(-5deg); }
}
.hes-loading-text {
  color: #fff;
  font-size: 2.3rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-shadow: 0 2px 12px #0b213faa;
}
</style>
