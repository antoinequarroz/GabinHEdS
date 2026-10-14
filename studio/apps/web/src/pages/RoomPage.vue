<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatLabels, type ProductionFormat, type RoomConfigInput } from '@gabin/shared';
import { useStudio } from '../composables/useStudio';
import Icon from '../components/Icon.vue';
const { state, busy, saveRoom, connectObs, technician } = useStudio();
const initial = state.value!.room;
const form = ref({ name: initial.name, obsUrl: initial.obsUrl, recordingRoot: initial.recordingRoot, defaultScenes: { ...initial.defaultScenes }, liveDestination: { name: initial.liveDestination.name, server: initial.liveDestination.server } });
const password = ref('');
const clearPassword = ref(false);
const liveKey = ref('');
const clearLiveKey = ref(false);
const formats: ProductionFormat[] = ['podcast', 'roundtable', 'slides'];
const obs = computed(() => state.value?.obs);
const configurationLocked = computed(() => !!obs.value?.recording || !!obs.value?.streaming || ['starting', 'live', 'stopping'].includes(state.value?.media.liveStatus ?? 'idle'));
async function save(): Promise<void> {
  const input: RoomConfigInput = { ...form.value, defaultScenes: { ...form.value.defaultScenes } };
  if (clearPassword.value) input.obsPassword = '';
  else if (password.value) input.obsPassword = password.value;
  if (clearLiveKey.value) input.liveDestination = { ...form.value.liveDestination, key: '' };
  else if (liveKey.value) input.liveDestination = { ...form.value.liveDestination, key: liveKey.value };
  if (await saveRoom(input)) { password.value = ''; clearPassword.value = false; liveKey.value = ''; clearLiveKey.value = false; }
}
</script>

<template>
  <div class="page-heading"><div><h1>Salle et OBS</h1><p>Préparez les sources, le stockage et la diffusion de votre salle.</p></div></div>

  <section class="setup-connection" :class="{ 'is-connected': obs?.connected }" aria-labelledby="obs-connection-title">
    <span class="setup-connection-icon"><Icon name="link" /></span>
    <div class="setup-connection-copy">
      <h2 id="obs-connection-title">Connexion à OBS</h2>
      <p>{{ obs?.connected ? 'La salle est reliée à OBS.' : 'Ouvrez OBS sur le PC de la salle, puis connectez-le à Nino.' }}</p>
      <span class="setup-server">{{ state?.room.obsUrl }}</span>
    </div>
    <div class="setup-connection-actions">
      <span class="badge" :class="obs?.connected ? '' : 'warning'">{{ obs?.connected ? 'OBS connecté' : obs?.connecting ? 'Connexion en cours' : 'OBS déconnecté' }}</span>
      <template v-if="technician">
        <button v-if="!obs?.connected" class="button primary" :disabled="busy.obs || obs?.connecting" @click="connectObs()"><Icon name="link" />{{ busy.obs || obs?.connecting ? 'Connexion à OBS…' : 'Connecter OBS' }}</button>
        <button v-else class="button" :disabled="busy.obs || obs?.recording" @click="connectObs(true)">Déconnecter OBS</button>
      </template>
    </div>
    <p v-if="obs?.error" class="banner error setup-connection-error">{{ obs.error }}</p>
  </section>

  <div class="setup-layout">
    <form v-if="technician" class="setup-form" @submit.prevent="save">
      <section class="setup-section">
        <div class="setup-section-heading"><Icon name="room" /><div><h2>La salle</h2><p>Ce nom sera visible sur le PC et les appareils associés.</p></div></div>
        <div class="setup-fields"><label class="field">Nom de la salle<input v-model="form.name" required maxlength="100" /></label></div>
      </section>

      <section class="setup-section">
        <div class="setup-section-heading"><Icon name="link" /><div><h2>Serveur OBS</h2><p>Enregistrez ces réglages avant de connecter OBS.</p></div></div>
        <div class="setup-fields">
          <label class="field">Adresse du serveur OBS<input v-model="form.obsUrl" required type="url" placeholder="ws://127.0.0.1:4455" /><span class="hint">L’adresse est utilisée depuis le PC de la salle. Gardez OBS sur ce PC.</span></label>
          <label class="field">Mot de passe OBS<input v-model="password" type="password" autocomplete="new-password" :disabled="clearPassword" :placeholder="state?.room.obsPasswordConfigured ? 'Mot de passe enregistré · laisser vide pour le conserver' : 'Mot de passe configuré dans OBS'" /></label>
          <label v-if="state?.room.obsPasswordConfigured" class="checkbox-field"><input v-model="clearPassword" type="checkbox" />Effacer le mot de passe enregistré</label>
        </div>
      </section>

      <section class="setup-section">
        <div class="setup-section-heading"><Icon name="projects" /><div><h2>Enregistrements</h2><p>Les vidéos restent sur le disque du PC de la salle.</p></div></div>
        <div class="setup-fields"><label class="field">Dossier des productions sur le PC<input v-model="form.recordingRoot" required placeholder="/Volumes/Productions" /><span class="hint">Un dossier par production et un sous-dossier par prise. Choisissez un disque avec assez d’espace.</span></label></div>
      </section>

      <section class="setup-section">
        <div class="setup-section-heading"><Icon name="movie" /><div><h2>Scènes affichées au démarrage</h2><p>Choisissez la scène initiale de chaque format.</p></div></div>
        <div class="setup-fields setup-scene-fields">
          <label v-for="format in formats" :key="format" class="field">{{ formatLabels[format] }}<select v-model="form.defaultScenes[format]"><option value="">Choisir un plan</option><option v-for="scene in obs?.scenes" :key="scene" :value="scene">{{ scene }}</option><option v-if="form.defaultScenes[format] && !obs?.scenes.includes(form.defaultScenes[format])" :value="form.defaultScenes[format]">{{ form.defaultScenes[format] }} (indisponible)</option></select></label>
        </div>
      </section>

      <section class="setup-section">
        <div class="setup-section-heading"><Icon name="broadcast" /><div><h2>Destination du direct</h2><p>La plateforme reçoit le programme de la salle.</p></div></div>
        <div class="setup-fields">
          <label class="field">Nom de la plateforme<input v-model="form.liveDestination.name" maxlength="100" placeholder="Ex. YouTube de la HEdS" /></label>
          <label class="field">Adresse du serveur RTMP / RTMPS<input v-model="form.liveDestination.server" type="url" placeholder="rtmps://serveur-de-la-plateforme/live" /><span class="hint">Copiez l’adresse de diffusion fournie par la plateforme.</span></label>
          <label class="field">Clé de diffusion<input v-model="liveKey" type="password" autocomplete="new-password" :disabled="clearLiveKey" :placeholder="state?.room.liveDestination.keyConfigured ? 'Clé enregistrée · laisser vide pour la conserver' : 'Clé fournie par la plateforme'" /><span class="hint">La clé reste sur le PC et n’est jamais renvoyée aux appareils.</span></label>
          <label v-if="state?.room.liveDestination.keyConfigured" class="checkbox-field"><input v-model="clearLiveKey" type="checkbox" />Effacer la clé de diffusion enregistrée</label>
        </div>
      </section>

      <div class="setup-savebar">
        <p class="hint">{{ configurationLocked ? 'Arrêtez le direct, le retour de la salle et l’enregistrement avant de modifier la configuration.' : 'Ces réglages s’appliquent à toutes les productions de la salle.' }}</p>
        <button class="button primary" :disabled="busy.room || configurationLocked">{{ busy.room ? 'Enregistrement…' : 'Enregistrer la configuration' }}</button>
      </div>
    </form>

    <aside class="setup-aside">
      <section class="setup-inventory">
        <h2>Sources détectées</h2>
        <p v-if="!obs?.connected" class="hint setup-inventory-note">Liste de la dernière connexion. Reconnectez OBS pour l’actualiser.</p>
        <div class="setup-source-counts"><div><strong>{{ obs?.scenes.length ?? 0 }}</strong><span>Plans OBS</span></div><div><strong>{{ obs?.inputs.length ?? 0 }}</strong><span>Entrées OBS</span></div></div>
        <div class="setup-source-group"><h3>Plans OBS</h3><ul v-if="obs?.scenes.length" class="setup-source-list"><li v-for="scene in obs.scenes" :key="scene"><Icon name="movie" /><span>{{ scene }}</span></li></ul><p v-else class="hint">Connectez OBS pour retrouver les plans de la salle.</p></div>
        <div class="setup-source-group"><h3>Entrées OBS</h3><ul v-if="obs?.inputs.length" class="setup-source-list"><li v-for="input in obs.inputs" :key="input.name"><Icon :name="input.muted !== null ? 'mic' : 'movie'" /><span>{{ input.name }}</span></li></ul><p v-else class="hint">Aucune entrée disponible.</p></div>
        <div class="setup-source-group"><h3>Dossier actuel OBS</h3><div class="file-path">{{ obs?.recordingDirectory || 'Non disponible' }}</div></div>
      </section>
      <details class="setup-help"><summary>Activer le serveur dans OBS</summary><div><p>Dans OBS, ouvrez Outils → Paramètres du serveur WebSocket. Activez le serveur et l’authentification, puis reportez le mot de passe dans Nino.</p><p class="hint">Aucune commande ne lance OBS à votre place.</p></div></details>
    </aside>
  </div>
</template>
