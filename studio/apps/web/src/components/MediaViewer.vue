<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { MediaAsset } from '@gabin/shared';
import { useStudio } from '../composables/useStudio';
import { failureText, playbackUrl, saveFile } from './filePlayback';
import Icon from './Icon.vue';
const props = defineProps<{ asset: MediaAsset | null }>();
const emit = defineEmits<{ close: [] }>();
const { mediaFileSession } = useStudio();
const dialog = ref<HTMLDialogElement | null>(null);
const source = ref('');
const loading = ref(false);
const downloading = ref(false);
const failure = ref('');
const expired = ref(false);
let generation = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
function reset(): void {
  generation++;
  clearTimeout(expiryTimer);
  dialog.value?.querySelectorAll('video,audio').forEach(element => { (element as HTMLMediaElement).pause(); element.removeAttribute('src'); (element as HTMLMediaElement).load(); });
  source.value = ''; loading.value = false; failure.value = ''; expired.value = false;
}
async function openFile(): Promise<void> {
  if (!props.asset) return;
  const current = ++generation;
  clearTimeout(expiryTimer);
  loading.value = true; failure.value = ''; expired.value = false;
  try {
    const session = await mediaFileSession(props.asset.id);
    if (current !== generation) return;
    source.value = playbackUrl(session);
    expiryTimer = setTimeout(() => {
      if (current !== generation) return;
      expired.value = true;
      failure.value = 'L’accès à cet aperçu a expiré. Renouvelez la lecture pour continuer.';
      dialog.value?.querySelectorAll('video,audio').forEach(element => (element as HTMLMediaElement).pause());
    }, Math.min(2_147_483_647, Math.max(0, Date.parse(session.expiresAt) - Date.now())));
  } catch (error) { if (current === generation) failure.value = failureText(error); }
  finally { if (current === generation) loading.value = false; }
}
async function download(): Promise<void> {
  const asset = props.asset;
  if (!asset || downloading.value) return;
  downloading.value = true;
  try { const session = await mediaFileSession(asset.id); saveFile(playbackUrl(session), ''); }
  catch (error) { failure.value = failureText(error, 'Le téléchargement ne peut pas démarrer. Réessayez.'); }
  finally { downloading.value = false; }
}
function mediaError(): void { failure.value = 'Ce fichier ne peut pas être lu dans ce navigateur. Vous pouvez récupérer l’original ou réessayer.'; }
watch(() => props.asset?.id, async id => {
  reset();
  const current = generation;
  await nextTick();
  if (current !== generation) return;
  if (!id) { dialog.value?.close(); return; }
  if (!dialog.value?.open) dialog.value?.showModal();
  void openFile();
}, { immediate: true });
onBeforeUnmount(reset);
</script>

<template>
  <dialog ref="dialog" class="media-viewer" aria-labelledby="media-viewer-title" @cancel.prevent="emit('close')" @close="emit('close')">
    <template v-if="asset">
      <header class="media-viewer-heading"><div><h2 id="media-viewer-title">{{ asset.title }}</h2><p>{{ asset.originalName }}</p></div><button class="icon-button" aria-label="Fermer l’aperçu" @click="emit('close')"><Icon name="close" /></button></header>
      <div class="media-viewer-stage">
        <div v-if="loading" class="media-viewer-wait" role="status"><span class="spinner" aria-hidden="true"></span><p>Ouverture du fichier…</p></div>
        <img v-else-if="source && asset.kind === 'image'" :src="source" :alt="asset.title" referrerpolicy="no-referrer" @error="mediaError" />
        <video v-else-if="source && asset.kind === 'video'" :src="source" controls playsinline preload="metadata" :aria-label="`Aperçu de ${asset.title}`" @error="mediaError" />
        <div v-else-if="source && asset.kind === 'audio'" class="media-viewer-audio"><Icon name="audio" /><audio :src="source" controls preload="metadata" :aria-label="`Aperçu audio de ${asset.title}`" @error="mediaError" /></div>
        <div v-else class="media-viewer-wait"><Icon :name="asset.kind === 'document' ? 'document' : 'warning'" /><p>{{ asset.kind === 'document' ? 'Téléchargez ce document pour l’ouvrir dans votre application de présentation.' : 'L’aperçu n’est pas disponible.' }}</p></div>
      </div>
      <p v-if="failure" class="banner warning" role="alert">{{ failure }}</p>
      <footer class="media-viewer-actions"><button v-if="expired || failure" class="button" :disabled="loading" @click="openFile"><Icon name="restore" />Renouveler l’aperçu</button><button class="button primary" :disabled="downloading" @click="download"><Icon name="download" />{{ downloading ? 'Ouverture du téléchargement…' : 'Télécharger le fichier' }}</button></footer>
    </template>
  </dialog>
</template>
