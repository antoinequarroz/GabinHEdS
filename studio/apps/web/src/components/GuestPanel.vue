<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Project, GuestSlot } from '@gabin/shared';
import { useStudio, newId } from '../composables/useStudio';
import { bridgeSessionKey } from '../guests/guestApi';
import Icon from './Icon.vue';
import AudioMeter from './AudioMeter.vue';
const props = defineProps<{ project: Project }>();
const { state, live, device, canEdit, busy, error, notice, inviteGuest, guestBridgeSession, control, guestInvitations } = useStudio();
const room = computed(() => state.value?.guestRooms?.[props.project.id]);
const names = ref<Record<number, string>>({ 1: '', 2: '' }); const invitations = computed(() => guestInvitations.value[props.project.id] ?? {}); const copied = ref('');
const pc = computed(() => device.value?.kind === 'pc' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname));
const disabled = computed(() => !canEdit.value || !live.value || !!busy.value.control);
const guest = (slot: number) => room.value?.guests.find(item => item.slot === slot && item.status !== 'removed');
const status = (item: GuestSlot | undefined) => !item ? 'Pas encore invité' : item.status === 'disconnected' ? 'Déconnecté' : item.admitted ? item.sourceReady ? item.muted ? 'Dans OBS · micro coupé' : 'Dans OBS' : 'Connexion OBS…' : item.mediaReady ? 'Prêt en salle d’attente' : item.joined ? 'Vérification caméra et micro…' : 'Invitation créée';
async function invite(slot: 1 | 2): Promise<void> { await inviteGuest(props.project.id, slot, names.value[slot]?.trim() || `Invité ${slot}`); }
async function copy(slot: number): Promise<void> {
  const text = invitations.value[slot]?.url; if (!text) return;
  try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(text); copied.value = `Lien de l’invité ${slot} copié.`; setTimeout(() => { copied.value = ''; }, 5000); }
  catch { error.value = 'Sélectionnez puis copiez le lien dans le champ de l’invitation.'; }
}
async function openBridge(): Promise<void> {
  if (!pc.value || disabled.value) return;
  const popup = window.open('about:blank', `nino-guest-${newId()}`, 'popup,width=1240,height=850');
  if (!popup) { error.value = 'Autorisez l’ouverture des fenêtres pour Nino puis réessayez.'; return; }
  const session = await guestBridgeSession(props.project.id);
  if (!session) { popup.close(); return; }
  try { popup.sessionStorage.setItem(bridgeSessionKey, JSON.stringify(session)); popup.location.replace(`${location.origin}/guest-bridge#guest-bridge`); popup.opener = null; notice.value = 'Choisissez la caméra virtuelle OBS et le micro de la salle dans la fenêtre de liaison.'; }
  catch { popup.close(); error.value = 'La fenêtre de liaison n’a pas pu s’ouvrir. Réessayez depuis le PC de la salle.'; }
}
async function remove(item: GuestSlot): Promise<void> { await control({ action: 'guest.remove', guestId: item.id }); }
const expiry = (value: string) => new Intl.DateTimeFormat('fr-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
</script>
<template>
  <section class="guest-panel" aria-labelledby="guest-panel-title"><div class="section-heading"><div><h2 id="guest-panel-title"><Icon name="devices" />Invités à distance</h2><p class="muted">Deux invités depuis leur navigateur.</p></div><span class="badge" :class="room?.bridge.mediaReady ? 'success' : 'neutral'">{{ room?.bridge.mediaReady ? 'Liaison de la salle prête' : room?.bridge.connected ? 'Vérification de la liaison…' : 'Liaison à ouvrir sur le PC' }}</span></div>
    <div class="guest-panel-setup"><button v-if="pc" class="button" :disabled="disabled || busy['guest-bridge'] || room?.bridge.connected" @click="openBridge"><Icon name="link" />{{ busy['guest-bridge'] ? 'Ouverture…' : 'Ouvrir la liaison de la salle' }}</button><button class="button" :disabled="disabled || !state?.obs.connected" @click="control({ action: 'guest.prepare', projectId: project.id })"><Icon name="camera" />Préparer les sources OBS</button><button v-if="room?.bridge.connected" class="button" :disabled="disabled" @click="control({ action: 'guest.bridge.stop', projectId: project.id })">Fermer la liaison</button></div>
    <p class="hint">Le PC transmet le programme OBS et le son de la salle. L’iPad et le Stream Deck contrôlent les invités sans ouvrir leur caméra ni leur micro.</p><p v-if="room?.bridge.error" class="banner warning" role="status">{{ room.bridge.error }}</p>
    <div class="guest-slots"><article v-for="slot in ([1, 2] as const)" :key="slot" class="guest-slot"><header><span class="guest-avatar"><Icon name="camera" /></span><div><h3>{{ guest(slot)?.name ?? `Invité ${slot}` }}</h3><p role="status">{{ status(guest(slot)) }}</p></div></header>
      <template v-if="!guest(slot)?.joined && !guest(slot)?.admitted"><label class="field" :for="`invite-name-${slot}`">Nom de l’invité<input :id="`invite-name-${slot}`" v-model="names[slot]" :placeholder="`Invité ${slot}`" maxlength="100" :disabled="disabled" /></label><button class="button" :disabled="disabled || busy[`guest-invite:${slot}`]" @click="invite(slot)">{{ busy[`guest-invite:${slot}`] ? 'Création du lien…' : invitations[slot] ? 'Créer un nouveau lien' : 'Créer un lien d’invitation' }}</button></template>
      <div v-if="invitations[slot]" class="guest-invitation"><label class="field" :for="`invite-link-${slot}`">Lien personnel<input :id="`invite-link-${slot}`" :value="invitations[slot].url" readonly /></label><button class="button compact" @click="copy(slot)">Copier le lien</button><p class="hint">Valable jusqu’au {{ expiry(invitations[slot].expiresAt) }}. Un nouveau lien invalide le précédent.</p></div>
      <AudioMeter v-if="guest(slot)?.admitted && guest(slot)?.sourceReady && state?.obs.inputs.some(input => input.name === guest(slot)?.inputName)" :input-name="guest(slot)!.inputName" :muted="guest(slot)!.muted" />
      <div v-if="guest(slot)?.joined" class="guest-slot-actions"><button v-if="!guest(slot)?.admitted" class="button primary" :disabled="disabled || !guest(slot)?.mediaReady || !room?.bridge.mediaReady || !state?.obs.connected" @click="control({ action: 'guest.admit', guestId: guest(slot)!.id })">Accueillir dans la conversation</button><template v-else><button class="button primary" :disabled="disabled || !guest(slot)?.sourceReady || !state?.obs.connected" @click="control({ action: 'guest.scene', guestId: guest(slot)!.id })"><Icon name="camera" />Afficher l’invité</button><button class="button" :disabled="disabled" @click="control({ action: 'guest.mute', guestId: guest(slot)!.id, muted: !guest(slot)!.muted })"><Icon name="mic" />{{ guest(slot)?.muted ? 'Réactiver le micro' : 'Couper le micro' }}</button></template></div><button v-if="guest(slot)" class="text-button guest-remove" :disabled="disabled" @click="remove(guest(slot)!)">{{ guest(slot)?.joined ? 'Retirer l’invité' : 'Révoquer l’invitation' }}</button><p v-if="guest(slot)?.error" class="banner warning" role="status">{{ guest(slot)?.error }}</p>
    </article></div><p v-if="copied" class="hint" role="status">{{ copied }}</p><details class="guest-network-help"><summary>Préparer un appel hors de la salle</summary><p class="hint">Partagez l’adresse HTTPS dédiée aux invités, avec le relais réseau TURN configuré par votre administrateur. Une adresse 127.0.0.1 fonctionne uniquement sur le PC. Gardez le contrôle de Nino sur le réseau privé.</p><p class="hint">La liaison demande une entrée audio contenant toutes les voix de la salle, sans les invités : par exemple le mixage de vos micros sur une interface audio. Chaque participant utilise un casque ou une solution audio anti-écho adaptée.</p></details>
  </section>
</template>
