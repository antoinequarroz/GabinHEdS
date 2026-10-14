<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { AuthResult, Device, PairingCode, MediaMode } from '@gabin/shared';
import { useStudio } from '../composables/useStudio';
import Icon from '../components/Icon.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
const { device, state, busy, getDevices, createPairing, createStreamDeck, revokeDevice, error } = useStudio();
const devices = ref<Device[]>([]);
const pairing = ref<PairingCode>();
const pairingRole = ref<'operator' | 'viewer'>('operator');
const deckName = ref('Stream Deck de la salle');
const credential = ref<AuthResult>();
const revoke = ref<Device>();
const copied = ref('');
const selectedProject = ref(state.value?.projects[0]?.id ?? '');
const startPayload = computed(() => JSON.stringify({ action: 'record.start', projectId: selectedProject.value }));
const livePayload = computed(() => JSON.stringify({ action: 'stream.start', projectId: selectedProject.value }));
const autoPayload = computed(() => JSON.stringify({ action: 'auto.start', projectId: selectedProject.value }));
const selectedGuest = ref('');
const projectGuests = computed(() => (state.value?.guestRooms?.[selectedProject.value]?.guests ?? []).filter(guest => guest.status !== 'removed'));
const guestCommands = computed(() => [
  { label: 'Accueillir l’invité', body: { action: 'guest.admit', guestId: selectedGuest.value } },
  { label: 'Afficher le plan de l’invité', body: { action: 'guest.scene', guestId: selectedGuest.value } },
  { label: 'Couper le micro de l’invité', body: { action: 'guest.mute', guestId: selectedGuest.value, muted: true } },
  { label: 'Réactiver le micro de l’invité', body: { action: 'guest.mute', guestId: selectedGuest.value, muted: false } },
  { label: 'Retirer l’invité et révoquer son lien', body: { action: 'guest.remove', guestId: selectedGuest.value } },
]);
watch(selectedProject, () => { selectedGuest.value = ''; });
const selectedAsset = ref('');
const mediaMode = ref<MediaMode>('fullscreen');
const availableMedia = computed(() => (state.value?.library ?? []).filter(asset => !asset.archivedAt && asset.kind !== 'document'));
const mediaAsset = computed(() => availableMedia.value.find(asset => asset.id === selectedAsset.value));
const mediaPayload = computed(() => JSON.stringify({ action: 'media.play', projectId: selectedProject.value, assetId: selectedAsset.value, mode: mediaAsset.value?.kind === 'audio' ? 'audio' : mediaMode.value }));
watch(selectedAsset, () => { mediaMode.value = mediaAsset.value?.kind === 'audio' ? 'audio' : 'fullscreen'; });
const accessUrls = computed(() => state.value?.accessUrls ?? []);
const roleLabel: Record<Device['role'], string> = { technician: 'Configuration et contrôle', operator: 'Préparation et contrôle', viewer: 'Consultation' };
async function load(): Promise<void> { const result = await getDevices(); if (result) devices.value = result; }
onMounted(load);
async function pair(): Promise<void> { const result = await createPairing(pairingRole.value); if (result) pairing.value = result; }
async function createDeck(): Promise<void> { if (!deckName.value.trim()) return; const result = await createStreamDeck(deckName.value.trim()); if (result) { credential.value = result; await load(); } }
async function confirmRevoke(): Promise<void> { const id = revoke.value?.id; if (id && await revokeDevice(id)) { if (credential.value?.device.id === id) credential.value = undefined; revoke.value = undefined; await load(); } }
async function copy(text: string, label: string): Promise<void> {
  copied.value = '';
  error.value = '';
  const manualCopy = 'La copie automatique n’est pas disponible sur cette connexion. Sélectionnez et copiez le texte dans le champ.';
  if (!navigator.clipboard?.writeText) { error.value = manualCopy; return; }
  try { await navigator.clipboard.writeText(text); copied.value = label; setTimeout(() => { copied.value = ''; }, 4000); }
  catch { error.value = manualCopy; }
}
const expiry = (value: string) => new Intl.DateTimeFormat('fr-CH', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
</script>

<template>
  <div class="page-heading"><div><h1>iPad et Stream Deck</h1><p>Retrouvez la même régie sur chaque appareil, avec un accès individuel.</p></div></div>

  <div class="devices-layout">
    <section class="devices-pairing">
      <div class="devices-panel-heading"><Icon name="devices" /><div><h2>Associer un iPad</h2><p>Connectez l’iPad au réseau local de la salle.</p></div></div>
      <ol class="devices-steps">
        <li class="devices-step">
          <span class="devices-step-number" aria-hidden="true">1</span>
          <div class="devices-step-content"><h3>Ouvrir Nino dans Safari</h3>
            <div v-if="accessUrls.length" class="devices-addresses"><div v-for="(url, index) in accessUrls" :key="url" class="field"><label :for="`ipad-address-${index}`">Adresse à ouvrir sur l’iPad</label><div class="devices-copy-field"><input :id="`ipad-address-${index}`" :value="url" readonly /><button class="button" @click="copy(url, 'Adresse copiée')">Copier l’adresse</button></div></div></div>
            <p v-else class="banner warning">Accès local uniquement : activez le réseau local sur le PC pour permettre la connexion d’un iPad.</p>
          </div>
        </li>
        <li class="devices-step">
          <span class="devices-step-number" aria-hidden="true">2</span>
          <div class="devices-step-content"><h3>Choisir son autorisation</h3><label class="field">Autorisation<select v-model="pairingRole"><option value="operator">Préparation et contrôle de la salle</option><option value="viewer">Consultation uniquement</option></select></label></div>
        </li>
        <li class="devices-step">
          <span class="devices-step-number" aria-hidden="true">3</span>
          <div class="devices-step-content"><h3>Saisir le code sur l’iPad</h3><button class="button primary" :disabled="busy.pairing" @click="pair">{{ busy.pairing ? 'Création du code…' : 'Créer un code d’association' }}</button>
            <div v-if="pairing" class="pairing-result" role="status"><span>Code à saisir sur l’iPad</span><strong class="pairing-code">{{ pairing.code }}</strong><span>Valable jusqu’à {{ expiry(pairing.expiresAt) }} · une seule utilisation</span><button class="button" @click="copy(pairing.code, 'Code copié')">Copier le code</button></div>
          </div>
        </li>
      </ol>
      <details class="devices-network-help"><summary>Si l’iPad ne trouve pas la salle</summary><p class="hint">L’administrateur du PC peut activer l’écoute réseau avec GABIN_HOST=0.0.0.0. Utilisez uniquement le réseau privé de la salle.</p></details>
    </section>

    <section class="devices-roster">
      <div class="section-heading"><div><h2>Appareils autorisés</h2><p class="muted">Un accès par appareil.</p></div><button class="button compact" :disabled="busy.devices" @click="load">Actualiser</button></div>
      <div class="devices-roster-list"><div v-for="item in devices" :key="item.id" class="device-row">
        <span class="devices-kind-icon"><Icon :name="item.kind === 'ipad' ? 'devices' : item.kind === 'streamdeck' ? 'settings' : 'room'" /></span>
        <div class="devices-device-copy"><strong>{{ item.name }}</strong><span v-if="item.id === device?.id" class="badge neutral">Cet appareil</span><p>{{ item.kind === 'ipad' ? 'iPad / mobile' : item.kind === 'streamdeck' ? 'Stream Deck' : 'PC' }}</p><span class="devices-permission">{{ roleLabel[item.role] }}</span></div>
        <button class="button compact" :disabled="item.id === device?.id || busy.revoke" @click="revoke = item">Révoquer</button>
      </div><p v-if="!devices.length" class="empty-inline">Chargement des appareils autorisés…</p></div>
      <p class="devices-roster-note hint">Révoquer un appareil supprime immédiatement son accès à la salle.</p>
    </section>
  </div>

  <section class="devices-deck">
    <div class="devices-deck-intro"><Icon name="settings" /><h2>Configurer un Stream Deck</h2><p>Déclenchez les commandes de la régie depuis les touches du Stream Deck.</p><p class="hint">Utilisez les requêtes HTTP de Bitfocus Companion ou d’un module Stream Deck pour piloter l’API de Nino.</p></div>
    <div class="devices-deck-form">
      <h3>Créer l’accès de l’appareil</h3>
      <div class="devices-deck-create"><label class="field">Nom de l’appareil<input v-model="deckName" maxlength="100" /></label><button class="button primary" :disabled="busy.streamdeck || !deckName.trim()" @click="createDeck">{{ busy.streamdeck ? 'Création de l’accès…' : 'Créer un accès Stream Deck' }}</button></div>
      <div v-if="credential" class="credential-result"><h3>Jeton d’accès · affiché une seule fois</h3><p class="hint">Copiez-le dans la configuration de votre Stream Deck. Il donne le droit de contrôler la salle.</p><label class="field">Jeton<textarea :value="credential.token" readonly rows="3" spellcheck="false" /></label><div class="actions"><button class="button" @click="copy(credential.token, 'Jeton copié')">Copier le jeton</button><button class="button" @click="credential = undefined">Masquer</button></div></div>
      <details class="devices-api-help api-help"><summary>Commandes à configurer dans Companion / Stream Deck</summary><div class="stack">
        <p>Adresse : celle du PC de la salle, suivie de <code>/api/control</code>. Méthode <code>POST</code>, format JSON. Ajoutez les en-têtes <code>Content-Type: application/json</code> et <code>Authorization: Bearer VOTRE_JETON</code>.</p>
        <label class="field">Production pour le bouton « Démarrer »<select v-model="selectedProject"><option value="">Choisir une production</option><option v-for="project in state?.projects" :key="project.id" :value="project.id">{{ project.title }}</option></select></label>
        <label v-if="selectedProject" class="field">Démarrer la prise<textarea :value="startPayload" readonly rows="2" spellcheck="false" /></label>
        <label v-if="selectedProject" class="field">Démarrer le direct<textarea :value="livePayload" readonly rows="2" spellcheck="false" /></label>
        <label v-if="selectedProject" class="field">Activer ou reprendre la réalisation automatique<textarea :value="autoPayload" readonly rows="2" spellcheck="false" /></label>
        <div class="command-examples"><div><strong>Revenir en manuel</strong><code>{ "action": "auto.stop" }</code></div></div>
        <p class="hint">Configurez les micros, les plans et la détection depuis la régie PC ou iPad. Une touche de sélection de plan suspend l’automatique ; la touche d’activation permet de la reprendre.</p>
        <div class="devices-media-recipes"><h3>Contrôler les invités à distance</h3><p class="hint">Créez les invitations depuis la production et ouvrez la liaison sur le PC. L’iPad et le Stream Deck utilisent ensuite les mêmes commandes.</p><label class="field" for="deck-guest">Invité pour les touches<select id="deck-guest" v-model="selectedGuest"><option value="">Choisir un invité de la production</option><option v-for="guest in projectGuests" :key="guest.id" :value="guest.id">{{ guest.name }}</option></select></label><template v-if="selectedGuest"><label v-for="command in guestCommands" :key="command.label" class="field">{{ command.label }}<textarea :value="JSON.stringify(command.body)" readonly rows="2" spellcheck="false" /></label></template><label v-if="selectedProject" class="field">Préparer les sources OBS des invités<textarea :value="JSON.stringify({ action: 'guest.prepare', projectId: selectedProject })" readonly rows="2" spellcheck="false" /></label><label v-if="selectedProject" class="field">Fermer la liaison des invités<textarea :value="JSON.stringify({ action: 'guest.bridge.stop', projectId: selectedProject })" readonly rows="2" spellcheck="false" /></label><p class="hint">Après une nouvelle invitation, vérifiez le nom et l’identifiant dans l’état de la production avant de réutiliser les touches. La sélection de son plan attend que sa vidéo soit réellement reçue dans OBS.</p></div>
        <div class="devices-media-recipes"><h3>Lancer un média de la bibliothèque</h3><label class="field">Média pour le bouton « Lancer »<select v-model="selectedAsset"><option value="">Choisir une image, une vidéo ou une musique</option><option v-for="asset in availableMedia" :key="asset.id" :value="asset.id">{{ asset.title }}</option></select></label><label v-if="mediaAsset && mediaAsset.kind !== 'audio'" class="field">Mode d’affichage<select v-model="mediaMode"><option value="fullscreen">Plein écran</option><option value="overlay">Superposition</option></select></label><label v-if="selectedProject && mediaAsset" class="field">Lancer le média<textarea :value="mediaPayload" readonly rows="3" spellcheck="false" /></label><p class="hint">Associez ce média à la production choisie avant de l’utiliser. Chaque commande conserve l’authentification propre au Stream Deck.</p></div>
        <div class="command-examples"><div><strong>Activer le retour</strong><code>{ "action": "preview.start" }</code></div><div><strong>Désactiver le retour</strong><code>{ "action": "preview.stop" }</code></div><div><strong>Arrêter le direct</strong><code>{ "action": "stream.stop" }</code></div><div><strong>Pause</strong><code>{ "action": "record.pause" }</code></div><div><strong>Reprendre</strong><code>{ "action": "record.resume" }</code></div><div><strong>Terminer</strong><code>{ "action": "record.stop" }</code></div><div><strong>Choisir un plan</strong><code>{ "action": "scene.set", "sceneName": "Plan large" }</code></div><div><strong>Ajouter un repère</strong><code>{ "action": "marker.add", "label": "À revoir" }</code></div></div>
        <p class="hint">Le direct et l’enregistrement sont indépendants. Arrêter le direct conserve le retour local et la prise en cours. Les noms de plans doivent correspondre exactement à ceux d’OBS. Nino vérifie les commandes et confirme le résultat avec OBS.</p>
        <div class="command-examples devices-media-commands"><div><strong>Mettre le média en pause</strong><code>{ "action": "media.pause" }</code></div><div><strong>Reprendre le média</strong><code>{ "action": "media.resume" }</code></div><div><strong>Arrêter / masquer le média</strong><code>{ "action": "media.stop" }</code></div></div>
      </div></details>
    </div>
  </section>

  <p v-if="copied" class="banner" role="status">{{ copied }}</p>
  <ConfirmDialog :open="!!revoke" title="Révoquer cet appareil ?" confirm-label="Révoquer l’accès" busy-label="Révocation de l’accès…" :busy="busy.revoke" dangerous @cancel="revoke = undefined" @confirm="confirmRevoke"><p>« {{ revoke?.name }} » ne pourra plus accéder au studio. Vous pourrez l’associer à nouveau si nécessaire.</p></ConfirmDialog>
</template>
