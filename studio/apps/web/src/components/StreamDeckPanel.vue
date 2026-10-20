<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { ProductionLaunchState, Project } from '@gabin/shared';
import { useStudio } from '../composables/useStudio';
import Icon from './Icon.vue';

const props = defineProps<{ project: Project; canStart: boolean; compact?: boolean }>();
const emit = defineEmits<{ regie: [] }>();
const { state, live, canEdit, busy, control, selectStreamDeckProject } = useStudio();
const dialog = ref<HTMLDialogElement | null>(null);
const confirming = ref(false);
const deck = computed(() => state.value?.streamDeck);
const selected = computed(() => deck.value?.projectId === props.project.id);
const synced = computed(() => selected.value && deck.value?.companionConnected && deck.value.syncedProjectId === props.project.id);
const selectedProject = computed(() => state.value?.projects.find(project => project.id === deck.value?.projectId));
const launch = computed(() => state.value?.launch?.projectId === props.project.id ? state.value.launch : null);
const running = computed(() => state.value?.launch?.status === 'running');
const ownRunning = computed(() => running.value && launch.value?.status === 'running');
const otherRunningProject = computed(() => running.value && !ownRunning.value
  ? state.value?.projects.find(project => project.id === state.value?.launch?.projectId) : null);
const liveActive = computed(() => ['starting', 'live', 'stopping'].includes(state.value?.media.liveStatus ?? 'idle'));
const mediaActive = computed(() => !!state.value?.mediaPlayback && state.value.mediaPlayback.status !== 'stopped');
const launchAllowed = computed(() => props.canStart && live.value && canEdit.value && !running.value && !busy.value.control
  && !state.value?.activeTake && !state.value?.obs.recording && !liveActive.value && !mediaActive.value && !introIssue.value);
const introLinks = computed(() => (state.value?.projectMedia?.[props.project.id] ?? []).filter(link => link.role === 'intro'));
const introAsset = computed(() => state.value?.library?.find(asset => asset.id === introLinks.value[0]?.assetId));
const introIssue = computed(() => {
  if (introLinks.value.length > 1) return 'Dans les médias de cette production, conservez une seule vidéo avec le rôle « Intro » avant de tout lancer.';
  if (!introLinks.value.length) return '';
  const asset = introAsset.value;
  return !asset || asset.archivedAt || asset.kind !== 'video' || !asset.durationMs || asset.durationMs > 30 * 60_000
    ? 'Choisissez une vidéo d’introduction disponible, de durée connue et inférieure à 30 minutes.' : '';
});
const intro = computed(() => !introIssue.value && introLinks.value.length === 1);
const automaticConfigured = computed(() => !!state.value?.autoDirectionSettings?.[props.project.id]);
const steps = computed<{ id: ProductionLaunchState['step']; label: string }[]>(() => [
  { id: 'preparing', label: 'Vérifications' },
  { id: 'preview', label: 'Retour vidéo' },
  { id: 'recording', label: 'Enregistrement' },
  ...(intro.value ? [{ id: 'intro' as const, label: 'Intro' }] : []),
  { id: 'scene', label: 'Scène de démarrage' },
  { id: 'auto', label: automaticConfigured.value ? 'Automatique' : 'Manuel' },
]);
const displaySteps = computed(() => {
  if (!launch.value || launch.value.status === 'idle') return steps.value;
  const items = steps.value.filter(step => step.id !== 'live');
  return launch.value.includeLive ? [...items, { id: 'live' as const, label: 'Direct' }] : items;
});
const currentStepIndex = computed(() => displaySteps.value.findIndex(step => step.id === launch.value?.step));
const deckStatus = computed(() => !live.value ? 'État à vérifier' : synced.value ? 'Synchronisé avec Companion'
  : selected.value ? deck.value?.companionConnected ? 'Synchronisation en attente' : 'Companion déconnecté'
    : deck.value?.projectId ? 'Autre production sélectionnée' : 'Aucune production sélectionnée');
const deckDetail = computed(() => !live.value ? 'Le PC de la salle ne transmet plus ses états. Reconnectez-vous avant de commander.'
  : synced.value ? 'Les touches utilisent les plans, micros, médias et invités de cette production.'
    : selected.value ? 'Nino a mémorisé votre choix. La réception par Companion n’est pas encore confirmée.'
      : selectedProject.value ? `Le Stream Deck utilise actuellement « ${selectedProject.value.title} ».`
        : 'Chargez cette production pour retrouver ses commandes sur le Stream Deck.');
const blockedReason = computed(() => !live.value ? 'Reconnectez le PC avant de lancer la séance.'
  : !canEdit.value ? 'Un accès opérateur est nécessaire pour lancer la séance.'
    : running.value ? ownRunning.value ? 'La séquence est déjà en cours.' : `Une séquence est en cours pour « ${otherRunningProject.value?.title || 'une autre production'} ».`
      : state.value?.activeTake || state.value?.obs.recording ? 'Une prise est déjà en cours. Terminez-la avant de lancer une nouvelle séance.'
        : liveActive.value ? 'Un direct est déjà actif. Terminez-le avant de lancer une nouvelle séance.'
          : mediaActive.value ? 'Arrêtez le média en cours avant de tout lancer.'
            : introIssue.value || (!props.canStart ? 'Vérifiez la salle et la connexion OBS avant de lancer la séance.' : ''));
const launchStatusLabel = computed(() => !live.value ? 'État à vérifier'
  : launch.value?.status === 'running' ? 'Séquence en cours'
    : launch.value?.status === 'completed' ? 'Séquence terminée'
      : launch.value?.status === 'cancelled' ? 'Séquence annulée' : 'Séquence interrompue');
const titleId = computed(() => `production-launch-title-${props.project.id}`);

watch(() => props.project.id, closeConfirmation);
watch([launchAllowed, confirming], ([allowed, open]) => { if (open && !allowed && !busy.value.control) closeConfirmation(); });
onBeforeUnmount(() => { dialog.value?.close(); });

async function openConfirmation(): Promise<void> {
  if (!launchAllowed.value) return;
  confirming.value = true;
  await nextTick();
  dialog.value?.showModal();
}
function closeConfirmation(): void { confirming.value = false; dialog.value?.close(); }
async function start(): Promise<void> {
  if (!launchAllowed.value) { closeConfirmation(); return; }
  const success = await control({ action: 'production.start', projectId: props.project.id, includeLive: false });
  closeConfirmation();
  if (success) emit('regie');
}
function stepState(index: number): string {
  if (!launch.value || !live.value) return '';
  if (launch.value.status === 'completed') return 'done';
  if (index < currentStepIndex.value) return 'done';
  if (index === currentStepIndex.value) return launch.value.status === 'running' ? 'current' : 'interrupted';
  return '';
}
</script>

<template>
  <section class="deck-production" :class="{ compact }" aria-label="Stream Deck et lancement de la production">
    <div v-if="compact" class="deck-compact-bar">
      <div class="deck-compact-identity"><strong>Stream Deck</strong><span class="deck-connection" :class="{ ready: live && synced, warning: selected && !synced || !live }" role="status"><span aria-hidden="true"></span>{{ deckStatus }}</span></div>
      <div v-if="canEdit" class="deck-compact-actions"><button class="button deck-select" :disabled="!live || busy['streamdeck-project'] || running" :aria-busy="!!busy['streamdeck-project']" @click="selectStreamDeckProject(project.id)"><Icon :name="synced ? 'check' : 'devices'" />{{ busy['streamdeck-project'] ? 'Sélection en cours…' : 'Utiliser cette production sur le Stream Deck' }}</button><button v-if="!ownRunning" class="button primary" :disabled="!launchAllowed" :title="blockedReason || 'Enregistrement, intro et scène de démarrage. Live séparé.'" @click="openConfirmation"><Icon name="play" />Tout lancer</button><button v-else class="button deck-cancel" :disabled="!live || busy.control" @click="control({ action: 'production.cancel' })"><Icon name="stop" />Annuler la séquence</button></div>
      <p v-if="selected && deck?.error" class="deck-error" role="status">{{ deck.error }}</p>
    </div>
    <template v-else>
    <div class="deck-assignment">
      <span class="deck-emblem" aria-hidden="true"><span v-for="key in 15" :key="key"></span></span>
      <div class="deck-assignment-copy">
        <h2>Votre production sur le Stream Deck</h2>
        <p>{{ deckDetail }}</p>
        <span class="deck-connection" :class="{ ready: live && synced, warning: selected && !synced || !live }" role="status"><span aria-hidden="true"></span>{{ deckStatus }}</span>
        <p v-if="selected && deck?.error" class="deck-error" role="status">{{ deck.error }}</p>
      </div>
      <button v-if="canEdit" class="button deck-select" :disabled="!live || busy['streamdeck-project'] || running" :aria-busy="!!busy['streamdeck-project']" @click="selectStreamDeckProject(project.id)"><Icon :name="synced ? 'check' : 'devices'" />{{ busy['streamdeck-project'] ? 'Sélection en cours…' : 'Utiliser cette production sur le Stream Deck' }}</button>
    </div>
    <div class="deck-launch">
      <div class="deck-launch-copy">
        <h3>Démarrer la séance</h3>
        <p>Une commande pour vérifier la salle, ouvrir le retour vidéo, enregistrer{{ intro ? ', jouer l’intro' : '' }} et afficher la scène de démarrage. {{ automaticConfigured ? 'La réalisation automatique prend ensuite le relais si les micros et les plans sont prêts.' : 'La réalisation restera manuelle : configurez l’automatique dans la régie pour l’ajouter.' }}</p>
        <details class="deck-launch-details"><summary>Voir les étapes</summary>
          <ol class="deck-launch-steps" aria-label="Étapes du lancement"><li v-for="(item, index) in steps" :key="item.id"><span>{{ index + 1 }}</span>{{ item.label }}</li></ol>
          <p class="deck-live-note">La connexion à Companion ne confirme pas que le boîtier USB est branché.</p>
        </details>
      </div>
      <div class="deck-launch-actions">
        <button v-if="canEdit && !ownRunning" class="button primary deck-launch-trigger" :disabled="!launchAllowed" @click="openConfirmation"><Icon name="play" /><span>Tout lancer</span></button>
        <button v-if="canEdit && ownRunning" class="button deck-cancel" :disabled="!live || busy.control" @click="control({ action: 'production.cancel' })"><Icon name="stop" />Annuler la séquence</button>
        <button class="text-button" @click="emit('regie')">Voir la régie</button>
        <p v-if="blockedReason && !ownRunning" class="deck-blocked">{{ blockedReason }}</p>
        <p v-if="ownRunning" class="deck-blocked">L’annulation conserve la prise déjà démarrée.</p>
        <p v-else class="deck-blocked">Le live se lance séparément.</p>
      </div>
    </div>
    </template>
    <div v-if="launch && launch.status !== 'idle'" class="deck-progress" :class="{ failed: launch.status === 'failed', uncertain: !live }">
      <div class="deck-progress-heading"><span class="deck-progress-indicator" :class="launch.status" aria-hidden="true"></span><strong>{{ launchStatusLabel }}</strong><span v-if="live && state?.obs.connected && state.obs.recording && state.activeTake?.id === launch.takeId" class="deck-recording"><span aria-hidden="true"></span>REC {{ state.obs.timecode }}</span></div>
      <p role="status" aria-live="polite">{{ live ? launch.message : 'Connexion interrompue. Vérifiez OBS avant de relancer une commande ; l’enregistrement a pu démarrer.' }}</p>
      <p v-if="ownRunning" class="deck-cancel-help">Annuler la séquence conserve l’enregistrement déjà démarré. Utilisez « Terminer la prise » pour l’arrêter.</p>
      <ol v-if="launch.status === 'running' || launch.status === 'failed'" class="deck-launch-steps deck-progress-steps" aria-label="Progression de la séquence"><li v-for="(item, index) in displaySteps" :key="item.id" :class="stepState(index)" :aria-current="stepState(index) === 'current' ? 'step' : undefined"><span><Icon v-if="stepState(index) === 'done'" name="check" /><template v-else>{{ index + 1 }}</template></span>{{ item.label }}</li></ol>
    </div>
  </section>
  <Teleport to="body">
    <dialog ref="dialog" class="confirm-dialog deck-start-dialog" :aria-labelledby="titleId" @cancel.prevent="!busy.control && closeConfirmation()">
      <h2 :id="titleId">Tout lancer pour cette production ?</h2>
      <div class="dialog-copy"><p>Une nouvelle prise de « {{ project.title }} » sera enregistrée sur le PC. Vérifiez le cadrage, les micros et les participants avant de commencer.</p><p>{{ intro ? 'L’intro associée sera enregistrée, puis Nino affichera la scène de démarrage.' : 'Aucune intro vidéo n’est associée. Nino affichera directement la scène de démarrage.' }} {{ automaticConfigured ? 'Nino tentera ensuite d’activer la réalisation automatique avec les réglages enregistrés. Si les micros ou plans ne sont pas prêts, la prise continuera en manuel.' : 'Les changements de plans resteront manuels.' }}</p><p>Le live se lance séparément dans la régie. Cette commande ne démarre aucune diffusion.</p></div>
      <div class="actions end"><button class="button" autofocus :disabled="busy.control" @click="closeConfirmation">Annuler</button><button class="button danger" :disabled="busy.control || !launchAllowed" @click="start">{{ busy.control ? 'Lancement demandé…' : 'Lancer l’enregistrement' }}</button></div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.deck-production { margin: 0 0 28px; border: 1px solid #ffffff13; border-radius: 16px; background: #202028d9; overflow: hidden; }
.deck-assignment { display: flex; align-items: center; gap: 20px; padding: 24px; }
.deck-emblem { width: 67px; min-width: 67px; display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; padding: 9px 7px; border: 1px solid #5d5d6b; background: #17171e; border-radius: 9px; transform: rotate(-4deg); }
.deck-emblem span { height: 10px; background: #cbd7e4; border-radius: 2px; opacity: .8; }
.deck-emblem span:nth-child(3n) { opacity: .32; }
.deck-assignment-copy { min-width: 0; flex: 1; }
.deck-assignment h2 { font-size: 15px; font-weight: 650; letter-spacing: -.15px; }
.deck-assignment p, .deck-launch p { margin: 7px 0 0; color: #b9b9ca; font-size: 12px; line-height: 1.65; max-width: 80ch; overflow-wrap: anywhere; }
.deck-connection { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; color: #b9b9ca; margin-top: 10px; }
.deck-connection > span { width: 6px; height: 6px; border-radius: 50%; background: #9191a2; }
.deck-connection.ready { color: #d0e4dc; }
.deck-connection.ready > span { background: #a9d0bf; }
.deck-connection.warning { color: #e6c994; }
.deck-connection.warning > span { background: #e6c994; }
.deck-assignment p.deck-error { color: #ecc495; }
.deck-select { max-width: 340px; white-space: normal; text-align: left; min-height: 44px; }
.deck-select svg { flex-shrink: 0; }
.deck-launch { display: flex; align-items: flex-start; gap: 32px; padding: 23px 24px; border-top: 1px solid #ffffff12; background: #17171d45; }
.deck-launch-copy { flex: 1; min-width: 0; }
.deck-launch h3 { font-size: 15px; font-weight: 650; }
.deck-launch-details { margin-top: 14px; }
.deck-launch-details summary { font-size: 11px; color: #c9d5e6; cursor: pointer; padding-block: 5px; width: fit-content; }
.deck-launch-steps { list-style: none; display: flex; gap: 13px 18px; flex-wrap: wrap; margin: 16px 0; padding: 0; }
.deck-launch-steps li { display: flex; align-items: center; gap: 7px; font-size: 10px; color: #c0c0cf; line-height: 1.4; }
.deck-launch-steps li > span { display: grid; place-items: center; width: 22px; height: 22px; border: 1px solid #ffffff24; border-radius: 6px; font-size: 10px; }
.deck-launch p.deck-live-note { font-size: 10px; margin-top: 12px; }
.deck-launch-actions { width: 200px; flex-shrink: 0; display: flex; flex-direction: column; align-items: stretch; gap: 12px; }
.deck-launch-trigger { min-height: 46px; font-size: 13px; }
.deck-launch-actions .text-button { align-self: center; }
.deck-launch-actions p.deck-blocked { font-size: 10px; margin: 0; text-align: center; }
.deck-cancel { white-space: normal; min-height: 44px; }
.deck-progress { padding: 19px 24px; border-top: 1px solid #bccde62a; background: #ccdcf207; }
.deck-progress.failed { border-color: #e8ac9c55; background: #c9635210; }
.deck-progress.uncertain { border-color: #dab48255; }
.deck-progress-heading { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.deck-progress-heading strong { font-size: 12px; }
.deck-progress-indicator { width: 7px; height: 7px; border-radius: 50%; background: #a6acbe; }
.deck-progress-indicator.running { background: #cbdcf2; box-shadow: 0 0 0 4px #cbdcf214; }
.deck-progress-indicator.completed { background: #a9d0bf; }
.deck-progress-indicator.failed { background: #e8ac9c; }
.deck-progress p { font-size: 12px; line-height: 1.7; color: #c4c4d1; margin-top: 9px; }
.deck-progress p.deck-cancel-help { font-size: 11px; color: #b2b2c3; }
.deck-progress-steps { margin-bottom: 0; }
.deck-progress-steps li { color: #a4a4b5; }
.deck-progress-steps li.done { color: #c5dcd3; }
.deck-progress-steps li.done > span { border-color: #9dc5b653; background: #9dc5b60d; }
.deck-progress-steps li.current { color: #f1f1f7; }
.deck-progress-steps li.current > span { background: #cadcf7; border-color: #cadcf7; color: #202028; }
.deck-progress-steps li.interrupted { color: #e6c994; }
.deck-progress-steps svg { width: 12px; height: 12px; }
.deck-recording { display: inline-flex; align-items: center; gap: 6px; color: #f0c1cc; font-size: 11px; margin-left: auto; font-variant-numeric: tabular-nums; }
.deck-recording > span { width: 6px; height: 6px; border-radius: 50%; background: #eb9cac; }
.deck-compact-bar { padding: 14px 18px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.deck-compact-identity { display: grid; gap: 5px; flex: 1; min-width: 190px; }
.deck-compact-identity > strong { font-size: 12px; font-weight: 650; }
.deck-compact-identity .deck-connection { margin: 0; }
.deck-compact-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.deck-compact-actions .button { font-size: 11px; min-height: 40px; }
.deck-compact-bar > .deck-error { flex-basis: 100%; font-size: 11px; color: #ecc495; overflow-wrap: anywhere; }
.compact .deck-progress { padding-block: 13px; }
.compact .deck-progress p { margin-top: 5px; font-size: 11px; }
@media (max-width: 1024px) {
  .deck-assignment { flex-wrap: wrap; gap: 15px; padding: 20px; }
  .deck-select { max-width: none; margin-left: 82px; }
  .deck-launch { padding: 20px; gap: 24px; }
  .deck-launch-details summary, .deck-launch-actions .text-button { min-height: 44px; display: flex; align-items: center; }
  .deck-progress { padding-inline: 20px; }
  .deck-compact-actions .deck-select { margin-left: 0; }
  .deck-compact-actions .button { min-height: 44px; }
}
@media (max-width: 640px) {
  .deck-assignment { padding: 18px; }
  .deck-assignment-copy { flex-basis: calc(100% - 82px); }
  .deck-select { margin-left: 0; width: 100%; justify-content: center; text-align: center; }
  .deck-compact-actions { width: 100%; }
  .deck-compact-actions .deck-select { width: auto; flex: 1 1 240px; }
  .deck-compact-actions > .button { flex: 1 1 100px; }
  .deck-launch { flex-direction: column; padding: 18px; gap: 18px; }
  .deck-launch-actions { width: 100%; }
  .deck-launch-steps { gap: 10px 13px; }
  .deck-progress { padding-inline: 18px; }
  .deck-start-dialog .actions { flex-wrap: wrap; }
  .deck-start-dialog .actions .button { flex: 1 1 160px; }
}
</style>
