<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Take } from '@gabin/shared';
import { useStudio } from '../composables/useStudio';
import { failureText, playbackUrl } from './filePlayback';
import Icon from './Icon.vue';
const props = defineProps<{ take: Take }>();
const { takePlaybackSession } = useStudio();
const opened = ref(false);
const phase = ref<'idle' | 'loading' | 'preparing' | 'ready' | 'failed'>('idle');
const source = ref('');
const failure = ref('');
const playBlocked = ref(false);
const video = ref<HTMLVideoElement | null>(null);
const available = computed(() => props.take.status === 'completed' && !!props.take.outputPath);
let generation = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let seekPosition = 0;
function release(): void {
  generation++;
  clearTimeout(pollTimer); clearTimeout(expiryTimer);
  if (video.value) { video.value.pause(); video.value.removeAttribute('src'); video.value.load(); }
  source.value = '';
}
function close(): void { release(); opened.value = false; phase.value = 'idle'; failure.value = ''; seekPosition = 0; }
async function poll(current: number): Promise<void> {
  if (!opened.value || current !== generation) return;
  try {
    const status = await takePlaybackSession(props.take.id);
    if (!opened.value || current !== generation) return;
    if (status.status === 'preparing') {
      phase.value = 'preparing';
      pollTimer = setTimeout(() => { void poll(current); }, 2000);
      return;
    }
    if (status.status !== 'ready' || !status.session) throw new Error(status.error || 'La copie de lecture n’a pas pu être préparée. Réessayez ou récupérez l’original.');
    source.value = playbackUrl(status.session);
    phase.value = 'ready'; failure.value = '';
    await nextTick();
    if (current !== generation) return;
    await play();
    if (current !== generation || !opened.value) return;
    expiryTimer = setTimeout(() => {
      if (!opened.value || current !== generation) return;
      seekPosition = video.value?.currentTime ?? 0;
      video.value?.pause();
      failure.value = 'L’accès à la lecture a expiré. Renouvelez-le pour continuer à cette position.';
    }, Math.min(2_147_483_647, Math.max(0, Date.parse(status.session.expiresAt) - Date.now())));
  } catch (error) { if (current === generation) { phase.value = 'failed'; failure.value = failureText(error); } }
}
async function open(): Promise<void> {
  if (!available.value) return;
  const position = video.value?.currentTime ?? seekPosition;
  release();
  seekPosition = position;
  opened.value = true; phase.value = 'loading'; failure.value = ''; playBlocked.value = false;
  const current = generation;
  await nextTick();
  if (current === generation) void poll(current);
}
function restorePosition(): void {
  if (video.value && seekPosition > 0 && Number.isFinite(video.value.duration)) video.value.currentTime = Math.min(seekPosition, Math.max(0, video.value.duration - .1));
}
function mediaError(): void { failure.value = 'La lecture est interrompue. Renouvelez l’accès ou téléchargez le fichier original.'; }
async function play(): Promise<void> {
  if (!video.value) return;
  const current = generation;
  try { await video.value.play(); if (current === generation) playBlocked.value = false; }
  catch { if (current === generation) playBlocked.value = true; }
}
watch(() => props.take.id, close);
onBeforeUnmount(release);
</script>

<template>
  <div class="take-playback">
    <button v-if="!opened" class="button take-playback-open" :disabled="!available" @click="open"><Icon name="play" />Lire la prise</button>
    <section v-else class="take-player" :aria-label="`Lecture de ${take.title}`">
      <header><strong>Aperçu de la prise {{ take.sequence }}</strong><button class="icon-button" aria-label="Fermer la lecture de la prise" @click="close"><Icon name="close" /></button></header>
      <div v-if="phase === 'loading' || phase === 'preparing'" class="take-player-wait" role="status"><span class="spinner" aria-hidden="true"></span><div><strong>{{ phase === 'preparing' ? 'Préparation de la lecture…' : 'Ouverture de la prise…' }}</strong><p>{{ phase === 'preparing' ? 'Le PC prépare une copie MP4 lisible sur cet appareil. Le fichier original est conservé.' : 'Demande d’accès au fichier enregistré sur le PC.' }}</p></div></div>
      <video v-if="source" ref="video" :src="source" controls playsinline preload="metadata" :aria-label="`Vidéo de ${take.title}`" @loadedmetadata="restorePosition" @error="mediaError" />
      <button v-if="playBlocked && !failure" class="button" @click="play"><Icon name="play" />Démarrer la lecture</button>
      <div v-if="failure" class="take-player-error" role="alert"><p>{{ failure }}</p><button class="button" @click="open"><Icon name="restore" />Renouveler la lecture</button></div>
      <p v-else-if="phase === 'ready'" class="hint">Lecture sur cet appareil · le téléchargement conserve le fichier original complet.</p>
    </section>
  </div>
</template>
