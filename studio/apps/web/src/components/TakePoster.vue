<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useStudio } from '../composables/useStudio';
import Icon from './Icon.vue';
const props = defineProps<{ takeId: string }>();
const { takeThumbnail } = useStudio();
const source = ref<string | null>(null);
const loading = ref(true);
let generation = 0;
watch(() => props.takeId, async id => {
  const current = ++generation;
  source.value = null;
  loading.value = true;
  const image = await takeThumbnail(id);
  if (current !== generation) return;
  source.value = image;
  loading.value = false;
}, { immediate: true });
onBeforeUnmount(() => { generation++; });
</script>

<template>
  <span class="take-poster">
    <img v-if="source" :src="source" alt="" loading="lazy" decoding="async" />
    <span v-else class="take-poster-empty"><Icon name="movie" /><small>{{ loading ? 'Chargement de la vignette…' : 'Aperçu indisponible' }}</small></span>
  </span>
</template>
