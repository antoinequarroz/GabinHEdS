<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useStudio } from '../composables/useStudio';
import Icon from './Icon.vue';
const props = defineProps<{ scene: string }>();
const { state, live, sceneThumbnail } = useStudio();
const imageData = ref<string | null>(null);
let generation = 0;
let pending = false;
let active = true;
async function refresh(): Promise<void> {
  if (pending || !active || document.hidden || !live.value || !state.value?.obs.connected) return;
  pending = true;
  const current = generation;
  try {
    const result = await sceneThumbnail(props.scene);
    if (active && generation === current && live.value && state.value?.obs.connected) {
      imageData.value = result?.available && /^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(result.imageData ?? '') ? result.imageData : null;
    }
  } finally { pending = false; }
}
watch(() => `${props.scene}:${live.value}:${state.value?.obs.connected}`, () => { generation++; imageData.value = null; void refresh(); }, { immediate: true });
const timer = setInterval(() => { void refresh(); }, 10_000);
onBeforeUnmount(() => { active = false; generation++; clearInterval(timer); });
</script>

<template>
  <span class="scene-preview">
    <img v-if="imageData" :src="imageData" alt="" loading="lazy" decoding="async" />
    <span v-else class="scene-preview-empty"><Icon name="camera" /><small>{{ state?.obs.connected ? 'Aperçu indisponible' : 'OBS déconnecté' }}</small></span>
  </span>
</template>
