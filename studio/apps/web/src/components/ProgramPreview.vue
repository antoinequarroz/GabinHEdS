<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type Hls from 'hls.js';
import { useStudio } from '../composables/useStudio';
import Icon from './Icon.vue';
import TakePoster from './TakePoster.vue';
defineProps<{ posterTakeId?: string }>();
const emit = defineEmits<{ configureRoom: [] }>();
const { state, live, canEdit, technician, busy, control, previewSession } = useStudio();
const video = ref<HTMLVideoElement | null>(null);
const loading = ref(false);
const ready = ref(false);
const sound = ref(false);
const playBlocked = ref(false);
const playerError = ref('');
const previewEnabled = computed(() => !!state.value?.obs.streaming);
const previewAvailable = computed(() => !!state.value?.media.previewReady);
const externalLive = computed(() => ['starting', 'live', 'stopping'].includes(state.value?.media.liveStatus ?? 'idle'));
const actionable = computed(() => live.value && canEdit.value && !!state.value?.obs.connected && !busy.value.control);
let hls: Hls | null = null;
let generation = 0;

function cleanup(): void {
  hls?.destroy();
  hls = null;
  ready.value = false;
  if (video.value) { video.value.pause(); video.value.removeAttribute('src'); video.value.load(); }
}

async function play(): Promise<void> {
  if (!video.value) return;
  try { await video.value.play(); playBlocked.value = false; }
  catch { playBlocked.value = true; loading.value = false; }
}

async function loadPreview(): Promise<void> {
  const current = ++generation;
  cleanup();
  playerError.value = '';
  loading.value = true;
  await nextTick();
  const session = await previewSession();
  if (generation !== current) return;
  if (!session) { loading.value = false; playerError.value = 'Le retour n’a pas pu être ouvert. Vérifiez le serveur puis réessayez.'; return; }
  const source = new URL(session.url, location.origin);
  if (source.origin !== location.origin || !source.pathname.startsWith('/api/monitor/')) {
    loading.value = false; playerError.value = 'L’adresse du retour vidéo est invalide.'; return;
  }
  const expiresIn = Date.parse(session.expiresAt) - Date.now();
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) { loading.value = false; playerError.value = 'L’accès au retour a expiré. Actualisez le lecteur.'; return; }
  // Segment requests keep an active session alive. Renew only when reopening
  // the player so a long recording never loses its monitor every 15 minutes.
  if (!video.value) return;
  video.value.muted = !sound.value;
  const nativeHls = !!video.value.canPlayType('application/vnd.apple.mpegurl');
  const iosWebKit = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const safariWebKit = navigator.vendor.includes('Apple')
    && !/Chrome|Chromium|Edg\/|OPR\//.test(navigator.userAgent);
  // Chromium can advertise native HLS without actually decoding this stream.
  // Apple browsers use their native player; desktop MSE browsers use hls.js.
  if (nativeHls && (iosWebKit || safariWebKit)) {
    video.value.src = source.href;
    await play();
    return;
  }
  try {
    const { default: HlsPlayer } = await import('hls.js');
    if (generation !== current || !video.value) return;
    if (!HlsPlayer.isSupported()) {
      if (nativeHls) { video.value.src = source.href; await play(); return; }
      loading.value = false; playerError.value = 'Ce navigateur ne peut pas lire le retour vidéo. Utilisez Safari sur iPad ou un navigateur récent sur PC.'; return;
    }
    hls = new HlsPlayer({ enableWorker: false, lowLatencyMode: true, backBufferLength: 15 });
    hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => { if (generation === current) void play(); });
    hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
      if (data.fatal && generation === current) {
        loading.value = false; ready.value = false;
        playerError.value = 'La lecture du retour est interrompue. Vérifiez le réseau et actualisez le lecteur.';
      }
    });
    hls.loadSource(source.href);
    hls.attachMedia(video.value);
  } catch { loading.value = false; playerError.value = 'Le lecteur vidéo n’a pas pu être chargé. Actualisez la page.'; }
}

async function toggleSound(): Promise<void> {
  if (!video.value) return;
  if (sound.value) { video.value.muted = true; sound.value = false; return; }
  video.value.muted = false;
  try { await video.value.play(); sound.value = true; playBlocked.value = false; }
  catch { video.value.muted = true; sound.value = false; playBlocked.value = true; playerError.value = 'Le navigateur a refusé la lecture audio. Relancez le lecteur puis réessayez.'; }
}
function videoError(): void { loading.value = false; ready.value = false; playerError.value = 'Le retour vidéo ne peut pas être lu. Vérifiez le flux local et actualisez le lecteur.'; }
watch(previewAvailable, available => {
  if (available) void loadPreview();
  else { generation++; cleanup(); loading.value = false; sound.value = false; playerError.value = ''; }
}, { immediate: true });
onBeforeUnmount(() => { generation++; cleanup(); });
</script>

<template>
  <section class="program-panel monitor-panel regie-monitor">
    <div class="program-header"><div class="monitor-heading"><Icon name="movie" /><span>Programme</span></div><span class="badge program-scene">{{ state?.obs.currentScene || 'Aucune scène' }}</span></div>
    <div class="program-video monitor-screen">
      <div v-if="!previewAvailable && !state?.obs.connected && posterTakeId" class="monitor-last-take"><TakePoster :take-id="posterTakeId" /><span>Dernière prise · image fixe</span></div>
      <video v-if="previewAvailable" ref="video" playsinline autoplay muted aria-label="Retour vidéo et audio du programme OBS" @playing="ready = true; loading = false; playerError = ''" @waiting="loading = true" @error="videoError" />
      <div v-if="!previewAvailable || !ready || loading || playerError" class="preview-overlay regie-monitor-empty">
        <span class="monitor-empty-icon" aria-hidden="true"><Icon name="camera" /></span>
        <h2>{{ !live ? 'Connexion au studio interrompue' : !state?.obs.connected ? 'Connectez OBS' : playerError ? 'Lecture interrompue' : loading ? 'Chargement du programme…' : previewEnabled ? 'Préparation du retour…' : 'Votre programme, ici' }}</h2>
        <p>{{ !live ? 'Le dernier état connu est conservé. Attendez la reconnexion pour contrôler le retour.' : !state?.obs.connected ? 'Connectez le PC de la salle à OBS pour retrouver l’image, le son et les commandes.' : playerError || state?.media.previewError || (previewEnabled ? 'Le flux OBS est actif. Le programme apparaîtra dès que le retour sera prêt.' : 'Activez le retour pour vérifier le cadrage et écouter le son de la salle.') }}</p>
        <button v-if="live && !state?.obs.connected && technician" class="button monitor-connect" @click="emit('configureRoom')"><Icon name="settings" />Ouvrir les réglages OBS</button>
        <button v-else-if="!previewEnabled && canEdit" class="button primary" :disabled="!actionable || !state?.media.available" @click="control({ action: 'preview.start' })"><Icon name="play" />Activer le retour</button>
        <p v-if="!state?.media.available" class="preview-note">Le service vidéo local n’est pas disponible. Vérifiez sa configuration sur le PC.</p>
        <button v-if="playerError && previewAvailable" class="button" :disabled="loading" @click="loadPreview">Actualiser le lecteur</button>
      </div>
    </div>
    <div class="preview-toolbar monitor-toolbar"><span class="monitor-latency"><span class="monitor-feed-dot" :class="{ ready: ready && previewAvailable }" aria-hidden="true"></span>{{ ready && previewAvailable ? 'Retour reçu' : 'Retour en attente' }}<span class="monitor-delay"> · décalé de quelques secondes</span></span><div class="actions monitor-controls"><button v-if="playBlocked && previewAvailable" class="button compact" @click="play">Lire le retour</button><button v-if="previewAvailable" class="button compact" :aria-pressed="sound" :disabled="!ready" @click="toggleSound"><Icon name="headphones" />{{ sound ? 'Couper le retour audio' : 'Écouter le retour' }}</button><button v-if="previewEnabled && canEdit" class="button compact" :disabled="!actionable || externalLive" @click="control({ action: 'preview.stop' })">Désactiver le retour</button></div></div>
    <p v-if="sound" class="preview-audio-note">Utilisez un casque pour éviter de renvoyer le son dans les micros de la salle.</p>
  </section>
</template>
