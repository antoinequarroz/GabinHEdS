<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useStudio } from '../composables/useStudio';
const props = defineProps<{ inputName: string; muted: boolean | null }>();
const { audioFrame, audioReceivedAt, live, state } = useStudio();
const now = ref(performance.now());
const timer = setInterval(() => { now.value = performance.now(); }, 250);
onBeforeUnmount(() => clearInterval(timer));
const level = computed(() => {
  if (!live.value || !state.value?.obs.connected || !audioFrame.value || Math.max(0, now.value - audioReceivedAt.value) > 1500) return null;
  return audioFrame.value.inputs.find(input => input.inputName === props.inputName) ?? null;
});
const rms = computed(() => level.value && !props.muted && Number.isFinite(level.value.rmsDb) ? level.value.rmsDb : -60);
const peak = computed(() => level.value && !props.muted && Number.isFinite(level.value.peakDb) ? level.value.peakDb : -60);
const percent = (value: number) => Math.max(0, Math.min(100, ((value + 60) / 60) * 100));
const description = computed(() => props.muted ? 'Micro coupé' : !level.value ? 'Signal en attente' : peak.value <= -60 ? 'Silence' : `Crête ${peak.value.toFixed(1)} dBFS`);
</script>

<template>
  <div class="audio-meter" :class="{ 'meter-unavailable': !level || muted, 'meter-clipping': !muted && peak >= -3, 'meter-active': !!level && !muted }" role="img" :aria-label="`Niveau du micro ${inputName} : ${description}`">
    <div class="meter-track"><span class="meter-fill" :style="{ width: `${percent(rms)}%` }"></span><span v-if="level && !muted" class="meter-peak" :style="{ left: `${percent(peak)}%` }"></span></div>
    <div class="meter-scale" aria-hidden="true"><span>−60</span><span>−30</span><span>0 dBFS</span></div>
    <div class="meter-description"><span>{{ description }}</span></div>
  </div>
</template>
