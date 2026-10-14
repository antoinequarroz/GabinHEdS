<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { MediaAsset } from '@gabin/shared';
import { useStudio } from '../composables/useStudio';
import { playbackUrl } from './filePlayback';
import Icon from './Icon.vue';
const props = defineProps<{ asset: MediaAsset }>();
const { mediaFileSession, mediaThumbnail } = useStudio();
const container = ref<HTMLElement | null>(null);
const source = ref('');
const loading = ref(false);
const visible = ref(false);
const icon = computed(() => props.asset.kind === 'image' ? 'image' : props.asset.kind === 'video' ? 'movie' : props.asset.kind === 'audio' ? 'audio' : 'document');
let generation = 0;
let active = true;
let observer: IntersectionObserver | undefined;
async function load(): Promise<void> {
  if (!active || !visible.value || !['image', 'video'].includes(props.asset.kind) || loading.value) return;
  const current = ++generation;
  loading.value = true;
  try {
    if (props.asset.kind === 'video') {
      const thumbnail = await mediaThumbnail(props.asset.id);
      if (active && current === generation) source.value = thumbnail && /^data:image\/(?:jpeg|png|webp);base64,[a-zA-Z0-9+/=]+$/.test(thumbnail) ? thumbnail : '';
    } else {
      const session = await mediaFileSession(props.asset.id);
      if (active && current === generation) source.value = playbackUrl(session);
    }
  } catch { if (active && current === generation) source.value = ''; }
  finally { if (current === generation) loading.value = false; }
}
watch(() => props.asset.id, () => { generation++; source.value = ''; loading.value = false; void load(); });
onMounted(() => {
  if (!('IntersectionObserver' in window)) { visible.value = true; void load(); return; }
  observer = new IntersectionObserver(entries => {
    visible.value = !!entries[0]?.isIntersecting;
    if (visible.value && !source.value) void load();
  }, { rootMargin: '160px' });
  if (container.value) observer.observe(container.value);
});
onBeforeUnmount(() => { active = false; generation++; observer?.disconnect(); });
</script>

<template>
  <span ref="container" class="media-preview">
    <img v-if="source" :src="source" :alt="asset.title" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="source = ''" />
    <span v-else class="media-preview-placeholder"><Icon :name="icon" /><small v-if="loading">Chargement…</small></span>
  </span>
</template>
