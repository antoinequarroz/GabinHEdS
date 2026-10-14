<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { GuestRoomState, GuestSession } from '@gabin/shared';
import StudioBrand from '../components/StudioBrand.vue';
import Icon from '../components/Icon.vue';
import { guestApi, type InvitationInfo } from '../guests/guestApi';
import { GuestConnection } from '../guests/guestConnection';
import { useCapture } from '../guests/useCapture';
import { videoHeartbeat } from '../guests/videoHeartbeat';
const props = defineProps<{ token: string }>();
const { stream, devices, camera, microphone, captureBusy, error: captureFailure, secure, open, stop } = useCapture();
const invitation = ref<InvitationInfo>(); const name = ref(''); const error = ref(''); const loading = ref(true); const busy = ref(false);
const session = shallowRef<GuestSession | null>(null); const room = shallowRef<GuestRoomState | null>(null);
const preview = ref<HTMLVideoElement>(); const programme = ref<HTMLVideoElement>(); const remote = shallowRef<MediaStream | null>(null);
const status = ref('Préparez votre caméra et votre micro.'); const connected = ref(false); const microphoneMuted = ref(false); const soundBlocked = ref(false);
let connection: GuestConnection | null = null;
let disposed = false;
let resumed: GuestSession | null = null;
videoHeartbeat(preview, () => connection?.setLocalReady(true));
const slot = computed(() => room.value?.guests.find(guest => guest.id === session.value?.guestId));
const resumeKey = computed(() => `nino.guest.resume:${props.token}`);
const admitted = computed(() => slot.value?.admitted ?? false);
watch([stream, preview], async ([value]) => { await nextTick(); if (preview.value) preview.value.srcObject = value; });
watch(remote, async value => { await nextTick(); if (programme.value) { programme.value.srcObject = value; try { await programme.value.play(); soundBlocked.value = false; } catch { soundBlocked.value = true; } } });
watch(admitted, value => { if (programme.value) programme.value.muted = !value; if (value) void enableSound(); });
async function load(): Promise<void> {
  loading.value = true; error.value = '';
  try {
    const saved = sessionStorage.getItem(resumeKey.value);
    if (saved) {
      try {
        const next = await guestApi<GuestSession>('resume', { token: saved });
        if (next.role !== 'guest') throw new Error('L’accès invité a expiré.');
        resumed = next; invitation.value = { name: next.name, title: next.roomTitle, slot: next.room.guests.find(guest => guest.id === next.guestId)?.slot ?? 1, expiresAt: next.expiresAt, available: true };
      } catch { sessionStorage.removeItem(resumeKey.value); }
    }
    if (!invitation.value) invitation.value = await guestApi<InvitationInfo>('invitation', { token: props.token });
    name.value = invitation.value.name;
    if (!invitation.value.available) error.value = invitation.value.error ?? 'Cette invitation n’est plus disponible. Demandez un nouveau lien à la salle.';
  }
  catch (failure) { error.value = failure instanceof Error ? failure.message : 'Cette invitation n’est plus disponible.'; }
  finally { loading.value = false; }
}
async function join(): Promise<void> {
  if (busy.value || !name.value.trim()) return; busy.value = true; error.value = '';
  try {
    const local = await open(); if (!local) return;
    const saved = sessionStorage.getItem(resumeKey.value);
    let next: GuestSession;
    try { next = resumed ?? (saved ? await guestApi<GuestSession>('resume', { token: saved }) : await guestApi<GuestSession>('join', { token: props.token, name: name.value.trim() })); }
    catch (failure) { if (saved) sessionStorage.removeItem(resumeKey.value); throw failure; }
    if (next.role !== 'guest') throw new Error('Ce lien ne donne pas accès à un appel invité.');
    if (disposed) { local.getTracks().forEach(track => track.stop()); return; }
    session.value = next; room.value = next.room; sessionStorage.setItem(resumeKey.value, next.token);
    connection = new GuestConnection(next, local, {
      room: value => { room.value = value; },
      stream: (_peer, value) => { remote.value = value; },
      status: (message, ready) => { status.value = message; connected.value = ready; },
      error: message => { error.value = message; },
    });
    await connection.start();
    if (preview.value?.readyState && preview.value.readyState >= 2) connection.setLocalReady(true);
  } catch (failure) { error.value = failure instanceof Error ? failure.message : 'La connexion à la salle a échoué.'; }
  finally { busy.value = false; }
}
function mute(): void { microphoneMuted.value = !microphoneMuted.value; stream.value?.getAudioTracks().forEach(track => { track.enabled = !microphoneMuted.value; }); }
async function leave(): Promise<void> { await connection?.close(); connection = null; stop(); session.value = null; remote.value = null; resumed = null; sessionStorage.removeItem(resumeKey.value); microphoneMuted.value = false; if (invitation.value) invitation.value = { ...invitation.value, available: false }; }
async function enableSound(): Promise<void> { if (!programme.value) return; programme.value.muted = !admitted.value; try { await programme.value.play(); soundBlocked.value = false; } catch { error.value = 'Le son n’a pas pu démarrer. Vérifiez les réglages audio du navigateur.'; } }
onMounted(load); onBeforeUnmount(() => { disposed = true; void connection?.close(); });
</script>

<template>
  <div class="guest-layout"><header class="guest-header"><StudioBrand /><span>Invité à distance</span></header>
    <main class="guest-main">
      <div class="guest-heading"><h1>{{ invitation?.title ?? 'Rejoindre la salle' }}</h1><p>{{ session ? admitted ? 'Vous participez à la conversation.' : 'La salle vous accueillera dès qu’elle sera prête.' : 'Prenez un instant pour vérifier votre image et votre son.' }}</p></div>
      <p v-if="loading" class="banner" role="status">Vérification de votre invitation…</p>
      <p v-if="error || captureFailure" class="banner error" role="alert">{{ error || captureFailure }}</p>
      <div v-if="invitation?.available" class="guest-call-layout">
        <section class="guest-video-panel">
          <div class="guest-programme"><video v-if="session" ref="programme" autoplay playsinline :muted="!admitted" /><video v-else ref="preview" autoplay playsinline muted @loadeddata="connection?.setLocalReady(true)" /><div v-if="session ? !remote || !admitted : !stream" class="guest-video-placeholder"><Icon :name="session ? 'headphones' : 'camera'" /><strong>{{ session ? 'Salle d’attente' : 'Votre caméra' }}</strong><p>{{ session ? 'Votre image est visible par la régie. Le retour de la salle commence après votre admission.' : 'Votre aperçu reste sur cet appareil jusqu’à ce que vous rejoigniez la salle.' }}</p></div></div>
          <div v-if="session" class="guest-self-preview"><video ref="preview" autoplay playsinline muted @loadeddata="connection?.setLocalReady(true)" /><span v-if="stream">{{ name || 'Votre aperçu' }}<Icon v-if="microphoneMuted" name="mic" /></span><p v-else>La caméra est arrêtée</p></div>
          <button v-if="session && soundBlocked && admitted" class="button primary" @click="enableSound">Activer le son de la salle</button>
        </section>
        <section class="guest-controls">
          <template v-if="!session"><h2>Avant de rejoindre</h2><label class="field" for="guest-name">Votre prénom / nom<input id="guest-name" v-model="name" maxlength="100" autocomplete="name" /></label><p class="hint">Utilisez un casque ou des écouteurs pour garder une conversation claire.</p>
            <button class="button" :disabled="captureBusy || !secure" @click="open"><Icon name="camera" />{{ captureBusy ? 'Ouverture des appareils…' : stream ? 'Actualiser l’aperçu' : 'Vérifier caméra et micro' }}</button>
            <template v-if="devices.length"><label class="field" for="guest-camera">Caméra<select id="guest-camera" v-model="camera" :disabled="captureBusy"><option v-for="item in devices.filter(item => item.kind === 'videoinput')" :key="item.deviceId" :value="item.deviceId">{{ item.label || 'Caméra' }}</option></select></label><label class="field" for="guest-mic">Micro<select id="guest-mic" v-model="microphone" :disabled="captureBusy"><option v-for="item in devices.filter(item => item.kind === 'audioinput')" :key="item.deviceId" :value="item.deviceId">{{ item.label || 'Microphone' }}</option></select></label><p class="hint">Après un changement d’appareil, actualisez l’aperçu.</p></template>
            <p v-if="!secure" class="banner warning">Ouvrez l’adresse HTTPS de votre invitation pour autoriser la caméra et le micro.</p><button class="button primary" :disabled="busy || captureBusy || !secure || !name.trim()" @click="join">{{ busy ? 'Connexion à la salle…' : 'Rejoindre la salle' }}<Icon name="arrow" /></button>
          </template>
          <template v-else><div class="guest-call-status" role="status"><span class="status-dot" :class="{ disconnected: !connected }"></span><strong>{{ admitted ? slot?.muted ? 'Votre son est coupé par la régie' : 'Dans la conversation' : 'En attente de la régie' }}</strong></div><p class="hint">{{ status }}</p><button class="button" :aria-pressed="microphoneMuted" @click="mute"><Icon name="mic" />{{ microphoneMuted ? 'Réactiver mon micro' : 'Couper mon micro' }}</button><button class="button danger" @click="leave"><Icon name="stop" />Quitter l’appel</button><p class="hint">La régie choisit le plan diffusé et contrôle l’enregistrement. Vous pouvez quitter l’appel à tout moment.</p></template>
        </section>
      </div>
      <p v-else-if="!loading" class="hint">Demandez à la salle une nouvelle invitation personnelle.</p>
    </main>
  </div>
</template>
