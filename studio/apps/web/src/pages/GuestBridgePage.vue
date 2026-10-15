<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { GuestPeer, GuestRoomState, GuestSession } from '@gabin/shared';
import StudioBrand from '../components/StudioBrand.vue';
import Icon from '../components/Icon.vue';
import { bridgeSessionKey, validSession } from '../guests/guestApi';
import { useCapture } from '../guests/useCapture';
import { GuestConnection } from '../guests/guestConnection';
import { videoHeartbeat } from '../guests/videoHeartbeat';
const { stream, devices, camera, microphone, captureBusy, error: captureFailure, open, stop, secure } = useCapture();
const session = shallowRef<GuestSession | null>(null); const room = shallowRef<GuestRoomState | null>(null);
const preview = ref<HTMLVideoElement>(); const error = ref(''); const connected = ref(false); const started = ref(false); const monitoring = ref(false); const audioConfirmed = ref(false); const cameraConfirmed = ref(false);
const status = ref('Ouvrez les appareils puis choisissez le programme OBS et le micro de la salle.');
const connecting = ref(false);
const selectionChanged = computed(() => {
  const actualCamera = stream.value?.getVideoTracks()[0]?.getSettings().deviceId;
  const actualMicrophone = stream.value?.getAudioTracks()[0]?.getSettings().deviceId;
  return !!(actualCamera && camera.value && actualCamera !== camera.value || actualMicrophone && microphone.value && actualMicrophone !== microphone.value);
});
const remotes = shallowRef<Record<string, MediaStream>>({}); let connection: GuestConnection | null = null;
videoHeartbeat(preview, () => connection?.setLocalReady(true));
const guests = computed(() => room.value?.guests ?? []);
watch(stream, async value => { await nextTick(); if (preview.value) preview.value.srcObject = value; });
async function checkDevices(): Promise<void> {
  const local = await open(); if (!local) return;
  const virtual = devices.value.find(item => item.kind === 'videoinput' && /obs.*virtual|virtual.*obs/i.test(item.label));
  if (virtual && camera.value !== virtual.deviceId) { camera.value = virtual.deviceId; await open(); }
}
async function start(): Promise<void> {
  error.value = '';
  if (!session.value || !audioConfirmed.value || !cameraConfirmed.value || started.value || connecting.value || selectionChanged.value) return;
  connecting.value = true;
  try {
    const local = stream.value; if (!local) return;
    connection = new GuestConnection(session.value, local, {
      room: value => { room.value = value; },
      stream: (peer, value) => { if (peer.role !== 'guest' || !peer.guestId) return; const next = { ...remotes.value }; if (value) next[peer.guestId] = value; else delete next[peer.guestId]; remotes.value = next; },
      status: (message, ready) => { status.value = message; connected.value = ready; },
      error: message => { error.value = message; },
    });
    await connection.start(); started.value = true; if (preview.value && preview.value.readyState >= 2) connection.setLocalReady(true);
  } catch (failure) { error.value = failure instanceof Error ? failure.message : 'La liaison n’a pas pu démarrer.'; await connection?.close(); connection = null; }
  finally { connecting.value = false; }
}
function remoteVideo(element: unknown, id: string): void { if (element instanceof HTMLVideoElement) { element.srcObject = remotes.value[id] ?? null; void element.play().catch(() => {}); } }
function monitor(): void { monitoring.value = !monitoring.value; connection?.monitor(monitoring.value); }
async function close(): Promise<void> { await connection?.close(); connection = null; started.value = false; monitoring.value = false; stop(); remotes.value = {}; }
onMounted(() => {
  try {
    const raw = sessionStorage.getItem(bridgeSessionKey); sessionStorage.removeItem(bridgeSessionKey);
    if (!raw) throw new Error('Ouvrez cette liaison depuis une production, sur le PC de la salle.');
    const next = validSession(JSON.parse(raw) as GuestSession);
    if (next.role !== 'bridge') throw new Error('Cet accès ne permet pas d’ouvrir la liaison de la salle.');
    session.value = next; room.value = next.room;
  } catch (failure) { error.value = failure instanceof Error ? failure.message : 'L’accès à la liaison a expiré.'; }
});
onBeforeUnmount(() => { void connection?.close(); });
</script>
<template>
  <div class="guest-layout"><header class="guest-header"><StudioBrand /><span>Liaison de la salle</span></header><main class="guest-main">
    <div class="guest-heading"><h1>{{ session?.roomTitle ?? 'Liaison des invités' }}</h1><p>Gardez cette fenêtre ouverte sur le PC pendant toute la conversation.</p></div>
    <p v-if="error || captureFailure" class="banner error" role="alert">{{ error || captureFailure }}</p>
    <div v-if="session" class="guest-call-layout"><section class="guest-video-panel"><div class="guest-programme"><video ref="preview" autoplay playsinline muted @loadeddata="connection?.setLocalReady(true)" /><div v-if="!stream" class="guest-video-placeholder"><Icon name="camera" /><strong>Programme OBS</strong><p>Démarrez la caméra virtuelle dans OBS, puis choisissez-la ici.</p></div></div><div class="bridge-guests"><article v-for="guest in guests" :key="guest.id"><video :ref="element => remoteVideo(element, guest.id)" autoplay playsinline muted /><span>{{ guest.name }}</span><small>{{ guest.admitted ? guest.sourceReady ? 'Dans OBS' : 'Connexion OBS…' : guest.joined ? 'Salle d’attente' : 'Invité attendu' }}</small></article></div></section>
      <section class="guest-controls"><h2>{{ started ? 'Conversation en cours' : 'Préparer la liaison' }}</h2><p class="hint">Le retour de chaque invité contient la salle et l’autre invité. Sa propre voix est exclue.</p>
        <template v-if="!started"><button class="button" :disabled="captureBusy || connecting || !secure" @click="checkDevices">{{ captureBusy ? 'Ouverture des appareils…' : stream ? 'Actualiser l’aperçu' : 'Ouvrir caméra et micro' }}</button><label v-if="devices.length" class="field" for="bridge-camera">Image du programme<select id="bridge-camera" v-model="camera" :disabled="captureBusy"><option v-for="item in devices.filter(item => item.kind === 'videoinput')" :key="item.deviceId" :value="item.deviceId">{{ item.label || 'Caméra' }}</option></select></label><label v-if="devices.length" class="field" for="bridge-microphone">Entrée audio de la salle<select id="bridge-microphone" v-model="microphone" :disabled="captureBusy"><option v-for="item in devices.filter(item => item.kind === 'audioinput')" :key="item.deviceId" :value="item.deviceId">{{ item.label || 'Microphone' }}</option></select></label><p v-if="selectionChanged" class="hint">Actualisez l’aperçu pour utiliser les appareils sélectionnés.</p><label class="guest-check"><input v-model="cameraConfirmed" type="checkbox" />L’image sélectionnée est le programme de la caméra virtuelle OBS.</label><label class="guest-check"><input v-model="audioConfirmed" type="checkbox" />Cette entrée contient toutes les voix de la salle, sans le retour sonore des invités.</label><p class="hint">Choisissez le mixage de vos micros de salle sur l’interface audio. Évitez le son système et le mixage final OBS : ils réintroduisent la voix des invités dans leur propre retour.</p><button class="button primary" :disabled="!stream || !audioConfirmed || !cameraConfirmed || captureBusy || connecting || selectionChanged || !secure" @click="start">{{ connecting ? 'Connexion…' : 'Connecter la salle aux invités' }}<Icon name="arrow" /></button></template>
        <template v-else><div class="guest-call-status" role="status"><span class="status-dot" :class="{ disconnected: !connected }"></span><strong>{{ connected ? 'Liaison connectée' : 'Connexion interrompue' }}</strong></div><p class="hint">{{ status }}</p><button class="button" :aria-pressed="monitoring" @click="monitor"><Icon name="headphones" />{{ monitoring ? 'Arrêter l’écoute' : 'Écouter les invités au casque' }}</button><p class="hint">Utilisez un casque sur le PC. Aucun son n’est joué par cette fenêtre avant d’activer cette écoute.</p><button class="button danger" @click="close">Fermer la liaison</button></template>
      </section></div>
  </main></div>
</template>
