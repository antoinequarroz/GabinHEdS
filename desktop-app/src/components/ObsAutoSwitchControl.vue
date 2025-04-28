<template>
  <div class="obs-auto-switch-control">
    <h3>Auto-switch OBS</h3>
    <div>
      <label>Scènes à cycler :</label>
      <input v-model="sceneInput" @keyup.enter="addScene" placeholder="Nom de la scène" />
      <button @click="addScene">Ajouter</button>
    </div>
    <ul>
      <li v-for="(scene, idx) in scenes" :key="scene">
        {{ scene }} <button @click="removeScene(idx)">x</button>
      </li>
    </ul>
    <div>
      <label>Intervalle (secondes) :</label>
      <input type="number" v-model.number="intervalSec" min="1" style="width:60px" />
    </div>
    <button @click="toggleAutoSwitch" :class="{active: autoSwitching}" style="margin-top:10px">
      {{ autoSwitching ? 'Arrêter' : 'Démarrer' }} l'auto-switch
    </button>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const scenes = ref(["Plan large", "Plan invité", "Plan animateur"]);
const sceneInput = ref("");
const intervalSec = ref(5);
const autoSwitching = ref(false);

// Appelle l'API backend pour démarrer/arrêter l'auto-switch
async function toggleAutoSwitch() {
  if (!autoSwitching.value) {
    await fetch('http://localhost:3030/obs/auto-switch/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenes: scenes.value, intervalMs: intervalSec.value * 1000 })
    });
    autoSwitching.value = true;
  } else {
    await fetch('http://localhost:3030/obs/auto-switch/stop', { method: 'POST' });
    autoSwitching.value = false;
  }
}

function addScene() {
  if (sceneInput.value && !scenes.value.includes(sceneInput.value)) {
    scenes.value.push(sceneInput.value);
    sceneInput.value = "";
  }
}
function removeScene(idx) {
  scenes.value.splice(idx, 1);
}
</script>

<style scoped>
.obs-auto-switch-control {
  background: #1e335c;
  color: #fff;
  border-radius: 12px;
  padding: 1.5rem;
  margin: 1rem 0;
  box-shadow: 0 2px 8px #0005;
  max-width: 340px;
}
.obs-auto-switch-control input[type="number"],
.obs-auto-switch-control input[type="text"] {
  border-radius: 6px;
  border: 1px solid #3e5a8c;
  padding: 0.2rem 0.5rem;
  margin: 0 0.5rem 0.5rem 0;
}
.obs-auto-switch-control button {
  background: #f3c300;
  color: #1e335c;
  border: none;
  border-radius: 7px;
  padding: 0.3rem 0.8rem;
  margin-left: 0.5rem;
  font-weight: bold;
  cursor: pointer;
  transition: background 0.18s;
}
.obs-auto-switch-control button.active {
  background: #e53935;
  color: #fff;
}
.obs-auto-switch-control ul {
  list-style: none;
  padding: 0;
  margin: 0 0 0.6rem 0;
}
.obs-auto-switch-control li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.2rem;
}
</style>
