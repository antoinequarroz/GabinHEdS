<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { type Preparation, type Project } from '@gabin/shared';
import { useStudio } from '../composables/useStudio';
import Icon from '../components/Icon.vue';
import ProjectForm from '../components/ProjectForm.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import ProgramPreview from '../components/ProgramPreview.vue';
import ScenePreview from '../components/ScenePreview.vue';
import AudioMeter from '../components/AudioMeter.vue';
import ProjectMedia from '../components/ProjectMedia.vue';
import TakePlayer from '../components/TakePlayer.vue';
import AutoDirection from '../components/AutoDirection.vue';
import GuestPanel from '../components/GuestPanel.vue';
const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ navigate: [path: string] }>();
const { state, live, canEdit, busy, preparation, control, downloadTake, exportProject, exportResolve, cancelResolveExport } = useStudio();
const step = ref<'prepare' | 'record' | 'takes'>('prepare');
const editing = ref(false);
const checks = ref<Preparation>();
const confirm = ref<'start' | 'stop' | 'liveStart' | 'liveStop' | null>(null);
const markerLabel = ref('');
const obs = computed(() => state.value?.obs);
const ownActiveTake = computed(() => state.value?.activeTake?.projectId === props.project.id ? state.value.activeTake : null);
const otherActiveTake = computed(() => state.value?.activeTake && state.value.activeTake.projectId !== props.project.id ? state.value.activeTake : null);
const takes = computed(() => state.value?.takes.filter(take => take.projectId === props.project.id).sort((a, b) => b.sequence - a.sequence) ?? []);
const markers = computed(() => state.value?.markers.filter(marker => marker.takeId === ownActiveTake.value?.id) ?? []);
const controllable = computed(() => live.value && canEdit.value && !!obs.value?.connected && !busy.value.control);
const relayControllable = computed(() => live.value && canEdit.value && !busy.value.control);
const media = computed(() => state.value?.media);
const liveActive = computed(() => ['starting', 'live', 'stopping'].includes(media.value?.liveStatus ?? 'idle'));
const ownLive = computed(() => liveActive.value && state.value?.liveProjectId === props.project.id);
const exportBlocked = computed(() => !!ownActiveTake.value || state.value?.liveProjectId === props.project.id);
const otherLiveId = computed(() => liveActive.value && state.value?.liveProjectId && state.value.liveProjectId !== props.project.id ? state.value.liveProjectId : null);
const otherLiveProject = computed(() => state.value?.projects.find(project => project.id === otherLiveId.value));
const canStart = computed(() => controllable.value && checks.value?.canStart && !obs.value?.recording && (!liveActive.value || ownLive.value));
const liveLabel = computed(() => !live.value ? 'Dernier état connu · connexion interrompue'
  : media.value?.liveStatus === 'starting' ? 'Connexion à la plateforme…'
  : media.value?.liveStatus === 'stopping' ? 'Arrêt de la diffusion…'
  : media.value?.liveStatus === 'live' ? 'Flux envoyé à la plateforme'
  : media.value?.liveStatus === 'error' ? 'Diffusion interrompue' : 'Aucune diffusion en cours');
const canStartLive = computed(() => controllable.value && media.value?.available && state.value?.room.liveDestination.keyConfigured && !liveActive.value
  && !otherActiveTake.value && !(obs.value?.recording && !state.value?.activeTake)
  && checks.value?.checks.every(check => ['idle', 'storage', 'disk'].includes(check.id) || check.status !== 'blocked'));
const confirmTitle = computed(() => confirm.value === 'start' ? 'Démarrer l’enregistrement ?' : confirm.value === 'stop' ? 'Terminer cette prise ?' : confirm.value === 'liveStart' ? 'Démarrer la diffusion en direct ?' : 'Arrêter la diffusion en direct ?');
const confirmLabel = computed(() => confirm.value === 'start' ? 'Démarrer dans OBS' : confirm.value === 'stop' ? 'Terminer et conserver la prise' : confirm.value === 'liveStart' ? 'Diffuser en direct' : 'Arrêter le direct');
const recordLabel = computed(() => !live.value ? 'Dernier état connu · connexion interrompue'
  : !obs.value?.connected ? 'OBS déconnecté · état à vérifier'
  : obs.value.recording ? obs.value.paused ? 'En pause · confirmé par OBS' : 'Enregistrement · confirmé par OBS'
  : checks.value?.canStart ? 'Prêt pour une nouvelle prise' : 'Salle à préparer');
const eligibleInputs = computed(() => {
  const names = new Set(props.project.participants.map(person => person.micInput).filter(Boolean));
  return obs.value?.inputs.filter(input => names.has(input.name) && input.muted !== null) ?? [];
});

async function refreshChecks(): Promise<void> { const result = await preparation(props.project.id); if (result) checks.value = result; }
watch(() => JSON.stringify({ id: props.project.id, updated: props.project.updatedAt, connected: obs.value?.connected, scenes: obs.value?.scenes, inputs: obs.value?.inputs.map(input => ({ name: input.name, muted: input.muted })), root: state.value?.room.recordingRoot, recording: obs.value?.recording, defaults: state.value?.room.defaultScenes, liveProjectId: state.value?.liveProjectId, liveStatus: media.value?.liveStatus }), refreshChecks, { immediate: true });
watch(ownActiveTake, (take, previous) => { if (take && !previous) step.value = 'record'; }, { immediate: true });
watch(step, () => window.scrollTo({ top: 0, behavior: 'instant' }), { flush: 'post' });

async function confirmRecording(): Promise<void> {
  if (!confirm.value) return;
  const action = confirm.value;
  const success = await control(action === 'start' ? { action: 'record.start', projectId: props.project.id }
    : action === 'stop' ? { action: 'record.stop' }
    : action === 'liveStart' ? { action: 'stream.start', projectId: props.project.id } : { action: 'stream.stop' });
  confirm.value = null;
  if (success) {
    if (action === 'stop' && !obs.value?.recording) step.value = 'takes';
    await refreshChecks();
  }
}
async function addMarker(): Promise<void> {
  const label = markerLabel.value.trim();
  if (label && await control({ action: 'marker.add', label })) markerLabel.value = '';
}
function duration(milliseconds: number): string { const seconds = Math.floor(milliseconds / 1000); return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`; }
function timestamp(value: string): string { return new Intl.DateTimeFormat('fr-CH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function bytes(value: number | null): string { return value === null ? 'Non mesuré' : `${(value / 1024 ** 3).toFixed(1)} Go`; }
</script>

<template>
  <div class="production-workspace" :class="`production-${step}`">
    <header class="production-toolbar">
      <div class="production-breadcrumbs"><button class="production-back" aria-label="Toutes les productions" @click="emit('navigate', 'projects')"><Icon name="back" /><span>Productions</span></button><span aria-hidden="true">/</span><span>{{ step === 'prepare' ? 'Préparation' : step === 'record' ? 'Régie' : 'Prises' }}</span></div>
      <div class="production-heading-row"><div class="production-title"><h1>{{ editing ? 'Modifier la production' : project.title }}</h1></div><button v-if="canEdit && !editing" class="button compact production-edit" :disabled="!!ownActiveTake || ownLive" @click="editing = true"><Icon name="edit" />Modifier</button></div>
    </header>
    <ProjectForm v-if="editing" :project="project" @saved="editing = false" @cancel="editing = false" />
    <template v-else>
      <nav class="production-workflow" aria-label="Étapes de la production">
        <button :aria-current="step === 'prepare' ? 'step' : undefined" @click="step = 'prepare'"><Icon name="check" /><span>Préparer la salle</span></button>
        <button :aria-current="step === 'record' ? 'step' : undefined" @click="step = 'record'"><Icon name="record" /><span>Enregistrer et diffuser</span></button>
        <button :aria-current="step === 'takes' ? 'step' : undefined" @click="step = 'takes'"><Icon name="movie" /><span>Retrouver les prises</span><small v-if="takes.length">{{ takes.length }}</small></button>
      </nav>
      <div v-if="otherActiveTake" class="banner warning production-notice"><Icon name="warning" /><span>Une prise est en cours pour une autre production. <button class="text-button" @click="emit('navigate', `project/${otherActiveTake.projectId}`)">Ouvrir cette production</button></span></div>
      <div v-if="otherLiveId" class="banner warning production-notice"><Icon name="broadcast" /><span>Le direct en cours concerne « {{ otherLiveProject?.title || 'une autre production' }} ». <button class="text-button" @click="emit('navigate', `project/${otherLiveId}`)">Ouvrir cette production</button></span></div>
      <div v-if="obs?.recording && !state?.activeTake" class="banner warning production-notice"><Icon name="warning" /><span>OBS enregistre une session démarrée en dehors de Nino. Cette vidéo n’est pas associée à ce projet. Terminez-la dans OBS avant de démarrer une nouvelle prise.</span></div>

      <div v-if="step === 'prepare'" class="prep-layout">
        <section class="prep-roster">
          <div class="prep-section-heading"><h2>Participants et plans</h2><p>{{ project.owner || 'Responsable non renseigné' }} · {{ project.participants.length }} participant{{ project.participants.length === 1 ? '' : 's' }}</p></div>
          <p v-if="project.description" class="prep-description">{{ project.description }}</p>
          <div v-if="!project.participants.length" class="empty-inline">Aucun participant renseigné. Modifiez le projet pour associer les micros.</div>
          <div class="prep-source-list">
            <article v-for="person in project.participants" :key="person.id" class="prep-source">
              <span class="prep-source-avatar" aria-hidden="true">{{ person.name.trim().charAt(0).toUpperCase() || '?' }}</span>
              <div class="prep-source-person"><strong>{{ person.name }}</strong><span><Icon name="mic" />{{ person.micInput || 'Micro à associer' }}</span><span><Icon name="movie" />{{ person.sceneName || 'Sans plan associé' }}</span></div>
              <span class="prep-source-state" :class="{ ready: person.micInput && person.sceneName }"><Icon :name="person.micInput && person.sceneName ? 'check' : 'warning'" /><span>{{ person.micInput && person.sceneName ? 'Associé' : 'À compléter' }}</span></span>
            </article>
          </div>
          <div class="prep-start-scene"><Icon name="movie" /><div><span>Scène affichée au démarrage</span><strong>{{ checks?.sceneName || 'À définir' }}</strong></div></div>
        </section>
        <section class="prep-readiness">
          <div class="prep-section-heading"><div><h2>Vérification de la salle</h2></div><button class="button compact" :disabled="busy[`preparation:${project.id}`]" @click="refreshChecks">{{ busy[`preparation:${project.id}`] ? 'Vérification…' : 'Vérifier' }}</button></div>
          <div class="prep-readiness-summary" :class="{ ready: checks?.canStart }"><Icon :name="checks?.canStart ? 'check' : 'warning'" /><div><strong>{{ checks?.canStart ? 'La salle est prête' : 'Configuration à vérifier' }}</strong><span>Contrôles du PC et de la connexion OBS</span></div><span class="prep-check-count">{{ checks?.checks.filter(check => check.status === 'ready').length ?? 0 }} / {{ checks?.checks.length ?? '—' }}</span></div>
          <div v-if="!checks" class="empty-inline">Vérification de la configuration en cours…</div>
          <div v-for="check in checks?.checks" :key="check.id" class="prep-check-row"><span class="check-icon" :class="check.status"><Icon :name="check.status === 'ready' ? 'check' : 'warning'" /></span><div><strong>{{ check.label }}</strong><p>{{ check.detail }}</p></div><span class="prep-check-status" :class="check.status">{{ check.status === 'ready' ? 'Prêt' : check.status === 'warning' ? 'À vérifier' : 'À corriger' }}</span></div>
          <p v-if="checks && !checks.canStart" class="hint">Corrigez les points bloquants avant d’enregistrer. Les paramètres se trouvent dans « Salle et OBS ».</p>
        </section>
        <section class="prep-delivery">
          <div class="prep-storage"><Icon name="projects" /><div><h2>Cette prise sera enregistrée ici</h2><div class="file-path">{{ checks?.recordingDirectory || 'Dossier à vérifier' }}</div></div><span class="prep-storage-space"><strong>{{ bytes(checks?.freeBytes ?? null) }}</strong><span>disponibles</span></span></div>
          <div class="prep-launch"><p>{{ checks?.canStart ? 'Vérifiez le cadrage et le son dans la régie avant de démarrer.' : 'Vous pouvez ouvrir la régie pour vérifier les retours et la connexion.' }}</p><button class="button primary" @click="step = 'record'">Ouvrir la régie<Icon name="arrow" /></button></div>
        </section>
        <ProjectMedia :project-id="project.id" @library="emit('navigate', 'library')" />
        <GuestPanel :project="project" />
      </div>

      <template v-else-if="step === 'record'">
        <div v-if="live && obs?.connected && !ownActiveTake && !canStart && !obs?.recording" class="regie-notice"><Icon name="warning" /><span>La salle n’est pas prête. Consultez les contrôles dans « Préparer la salle ».</span></div>
        <div class="regie-layout">
          <div class="regie-stage">
            <ProgramPreview :poster-take-id="takes.find(take => take.status === 'completed' && take.outputPath)?.id" @configure-room="emit('navigate', 'room')" />
            <section class="regie-scene-strip" aria-label="Choisir le plan du programme">
              <div class="regie-strip-heading"><h2>Changer de plan</h2><span>{{ obs?.scenes.length ?? 0 }} scène{{ obs?.scenes.length === 1 ? '' : 's' }} OBS</span></div>
              <div class="regie-scene-list">
                <button v-for="scene in obs?.scenes" :key="scene" class="regie-scene" :aria-label="scene" :aria-pressed="obs?.currentScene === scene" :disabled="!controllable" @click="control({ action: 'scene.set', sceneName: scene })">
                  <span class="regie-scene-image"><ScenePreview :scene="scene" /><span v-if="obs?.currentScene === scene" class="regie-scene-tag"><span aria-hidden="true"></span>{{ live && obs?.connected ? 'Programme' : 'Dernier plan connu' }}</span></span>
                  <span class="regie-scene-footer"><span class="regie-scene-copy"><strong>{{ scene }}</strong><small>{{ obs?.currentScene === scene ? live && obs?.connected ? 'Plan affiché' : 'État à vérifier' : 'Choisir ce plan' }}</small></span><Icon :name="obs?.currentScene === scene ? 'check' : 'movie'" /></span>
                </button>
              </div>
              <p v-if="!obs?.scenes.length" class="empty-inline">Les plans apparaîtront après la connexion à OBS.</p>
            </section>
          </div>
          <aside class="regie-inspector">
            <section class="regie-live">
              <header class="regie-section-heading"><div><Icon name="broadcast" /><h2>Diffusion en direct</h2></div><span class="regie-status" :class="!live || !obs?.connected ? 'warning' : media?.liveStatus === 'live' ? 'active' : media?.liveStatus === 'error' ? 'error' : 'idle'">{{ !live ? 'État à vérifier' : !obs?.connected && liveActive ? 'Source à vérifier' : media?.liveStatus === 'live' ? 'Live' : media?.liveStatus === 'starting' ? 'Connexion' : media?.liveStatus === 'stopping' ? 'Arrêt en cours' : media?.liveStatus === 'error' ? 'Interrompu' : 'Arrêté' }}</span></header>
              <div class="regie-live-destination"><Icon name="broadcast" /><strong>{{ media?.liveDestination || state?.room.liveDestination.name || 'Plateforme à configurer' }}</strong></div>
              <p v-if="otherLiveId" class="hint">Production diffusée : {{ otherLiveProject?.title || 'Autre production' }}</p>
              <div class="regie-live-state"><span>{{ liveLabel }}</span><span v-if="liveActive" class="timecode">{{ media?.liveTimecode || '00:00:00' }}</span></div>
              <p v-if="media?.liveError" class="banner error">{{ media.liveError }}</p>
              <button v-if="liveActive && canEdit" class="button danger regie-live-trigger" aria-label="Arrêter le direct" :disabled="!relayControllable || media?.liveStatus === 'stopping'" @click="confirm = 'liveStop'"><span class="regie-action-icon"><Icon name="stop" /></span><span>Arrêter le direct</span></button>
              <button v-else-if="canEdit" class="button regie-live-trigger" aria-label="Diffuser en direct" :disabled="!canStartLive" @click="confirm = 'liveStart'"><span class="regie-action-icon"><Icon name="broadcast" /></span><span>Diffuser en direct</span></button>
              <details class="regie-help"><summary>À propos du direct</summary><p>Vérifiez la réception sur la plateforme. Le direct et la prise sont indépendants.</p></details>
            </section>
            <AutoDirection :project="project" />
            <GuestPanel :project="project" />
            <section class="regie-audio">
              <header class="regie-section-heading"><div><Icon name="mic" /><h2>Micros des participants</h2></div><span class="regie-input-count">{{ eligibleInputs.length }}</span></header>
              <p v-if="!eligibleInputs.length" class="empty-inline">{{ obs?.connected ? 'Associez les micros dans les paramètres de la production.' : 'Connectez OBS pour retrouver les micros de la production.' }}</p>
              <div class="regie-audio-channels">
                <div v-for="input in eligibleInputs" :key="input.name" class="regie-audio-channel">
                  <div class="regie-channel-heading"><span class="regie-channel-avatar" aria-hidden="true"><Icon name="mic" /></span><strong>{{ input.name }}</strong><span :class="{ muted: input.muted }">{{ input.muted ? 'Coupé' : 'Actif' }}</span></div>
                  <AudioMeter :input-name="input.name" :muted="input.muted" />
                  <div class="regie-channel-control"><span>Gain OBS <strong>{{ input.volumeDb === null ? '—' : `${input.volumeDb.toFixed(1)} dB` }}</strong></span><button class="button compact" :class="input.muted ? 'warning' : ''" :disabled="!controllable" @click="control({ action: 'input.mute', inputName: input.name, muted: !input.muted })">{{ input.muted ? 'Réactiver' : 'Couper' }}</button></div>
                </div>
              </div>
              <details class="regie-help"><summary>Réglage des micros</summary><p>Les niveaux sont reçus d’OBS. Le gain se règle dans OBS.</p></details>
            </section>
            <ProjectMedia :project-id="project.id" mode="regie" @prepare="step = 'prepare'" @library="emit('navigate', 'library')" />
          </aside>
        </div>
        <details v-if="ownActiveTake" class="regie-markers" open>
          <summary><Icon name="mark" /><span>Repères de montage</span><small>{{ markers.length }} · prise {{ ownActiveTake.sequence }}</small></summary>
          <div class="regie-markers-body"><form v-if="canEdit" class="marker-form" @submit.prevent="addMarker"><label class="sr-only" for="marker-label">Nom du repère</label><input id="marker-label" v-model="markerLabel" maxlength="160" placeholder="Ex. Bonne réponse, reprise ou passage à couper" /><button class="button" :disabled="!controllable || !markerLabel.trim()"><Icon name="mark" />Ajouter un repère</button></form><p v-if="!markers.length" class="hint">Les repères conservent la position dans la prise pour préparer le montage.</p><div v-for="marker in markers" :key="marker.id" class="marker-row"><span>{{ duration(marker.offsetMs) }}</span><strong>{{ marker.label }}</strong></div></div>
        </details>
        <section class="regie-transport" aria-label="Contrôle de l’enregistrement">
          <div class="regie-time"><span class="record-light" :class="{ active: live && obs?.connected && obs.recording, paused: live && obs?.connected && obs.paused, uncertain: !live || !obs?.connected }"></span><span class="timecode">{{ obs?.recording ? obs.timecode : '00:00:00' }}</span></div>
          <div class="regie-take-state"><strong>{{ recordLabel }}</strong><span>{{ ownActiveTake ? `Prise ${String(ownActiveTake.sequence).padStart(2, '0')} · original sur le PC` : 'Original conservé sur le PC de la salle' }}</span></div>
          <div class="regie-record-actions">
            <template v-if="ownActiveTake && obs?.recording"><button class="button" :disabled="!controllable" @click="control({ action: obs.paused ? 'record.resume' : 'record.pause' })"><Icon :name="obs.paused ? 'play' : 'pause'" />{{ obs.paused ? 'Reprendre' : 'Pause' }}</button><button class="button danger" :disabled="!controllable" @click="confirm = 'stop'"><Icon name="stop" />Terminer la prise</button></template>
            <button v-else-if="canEdit" class="button primary regie-record-trigger" aria-label="Démarrer la prise" :disabled="!canStart" @click="confirm = 'start'"><span class="regie-record-dot" aria-hidden="true"></span><span>Enregistrer</span></button>
          </div>
        </section>
      </template>

      <section v-else class="takes-library">
        <header class="takes-heading"><div><h2>Les prises de cette production</h2><p>Relisez les vidéos ici ou récupérez une copie complète sur cet appareil.</p></div><div class="takes-heading-actions"><template v-if="takes.some(take => take.status === 'completed' && take.outputPath)"><button class="button primary" :disabled="busy[`export:${project.id}`] || exportBlocked" @click="exportProject(project.id)"><Icon name="download" />{{ busy[`export:${project.id}`] ? 'Préparation du dossier…' : 'Récupérer le dossier complet' }}</button><button class="button" :disabled="busy[`resolve-export:${project.id}`] || exportBlocked" @click="exportResolve(project.id)"><Icon name="movie" />{{ busy[`resolve-export:${project.id}`] ? 'Préparation pour DaVinci Resolve…' : 'Télécharger pour DaVinci Resolve' }}</button><button v-if="busy[`resolve-export:${project.id}`]" class="text-button" @click="cancelResolveExport(project.id)">Annuler l’attente</button></template><button v-if="canEdit" class="button" :disabled="!!obs?.recording" @click="step = 'prepare'"><Icon name="plus" />Nouvelle prise</button></div></header>
        <p v-if="exportBlocked" class="hint">Terminez la prise et le direct avant de récupérer le dossier.</p>
        <p v-if="takes.some(take => take.status === 'completed' && take.outputPath)" class="takes-export-note">Le dossier ZIP rassemble les vidéos originales terminées, les médias associés et les repères de montage. La préparation peut prendre du temps sur le PC.</p>
        <p v-if="takes.some(take => take.status === 'completed' && take.outputPath)" class="takes-export-note">Pour DaVinci Resolve : décompressez le dossier, puis choisissez Fichier → Importer → Timeline et une timeline .otio. Les changements de caméra sont déjà dans le programme enregistré ; les repères permettent de les retrouver. Les angles caméra séparés ne sont pas enregistrés.</p>
        <div v-if="!takes.length" class="takes-empty"><Icon name="movie" /><h3>Aucune prise enregistrée</h3><p>Préparez la salle, puis démarrez votre premier enregistrement.</p><button class="button primary" @click="step = 'prepare'">Configurer la première prise<Icon name="arrow" /></button></div>
        <template v-else>
          <div class="takes-list-heading" aria-hidden="true"><span>Prise</span><span>Fichier et informations</span><span>Récupération</span></div>
          <article v-for="take in takes" :key="take.id" class="takes-row">
            <div class="takes-index"><Icon name="movie" /><span>{{ String(take.sequence).padStart(2, '0') }}</span><small>PRISE</small></div>
            <div class="takes-details"><div class="takes-title"><h3>{{ take.title }}</h3><span class="badge" :class="take.status === 'completed' ? '' : take.status === 'interrupted' ? 'warning' : 'recording'">{{ take.status === 'completed' ? 'Terminée' : take.status === 'interrupted' ? 'Interrompue' : take.status === 'paused' ? 'En pause' : 'En cours' }}</span></div><div class="takes-metadata"><span>{{ timestamp(take.startedAt) }}</span><span>{{ duration(take.durationMs) }}</span><span><Icon name="mark" />{{ state?.markers.filter(marker => marker.takeId === take.id).length ?? 0 }} repère(s) de montage</span></div><div class="file-path">{{ take.outputPath || (take.status === 'recording' || take.status === 'paused' ? 'Le chemin du fichier sera confirmé par OBS à la fin de la prise.' : 'Aucun fichier final confirmé. Vérifiez le dossier d’enregistrement dans OBS.') }}</div><TakePlayer v-if="take.status === 'completed' && take.outputPath" :take="take" /></div>
            <div class="takes-delivery"><button v-if="take.status === 'completed' && take.outputPath" class="button primary" :disabled="busy[`download:${take.id}`]" @click="downloadTake(take.id)"><Icon name="download" />{{ busy[`download:${take.id}`] ? 'Préparation du téléchargement…' : 'Télécharger le fichier' }}</button><span v-else class="hint">{{ take.status === 'recording' || take.status === 'paused' ? 'Fichier en cours d’écriture' : 'Fichier final à vérifier' }}</span><small v-if="take.status === 'completed' && take.outputPath">Vidéo originale complète</small></div>
          </article>
        </template>
      </section>
    </template>
  </div>
  <ConfirmDialog :open="!!confirm" :title="confirmTitle" :confirm-label="confirmLabel" :busy="busy.control" dangerous @cancel="confirm = null" @confirm="confirmRecording"><p v-if="confirm === 'start'">La nouvelle prise de « {{ project.title }} » sera enregistrée sur le PC de la salle. L’état affiché sera celui confirmé par OBS.</p><p v-else-if="confirm === 'stop'">OBS va terminer le fichier. Attendez sa confirmation avant de récupérer la vidéo.</p><p v-else-if="confirm === 'liveStart'">Le programme de « {{ project.title }} » sera envoyé à {{ state?.room.liveDestination.name || 'la plateforme configurée' }}. Vérifiez l’image et le son avant de commencer. L’enregistrement reste une commande distincte.</p><p v-else>La diffusion <template v-if="otherLiveId">de « {{ otherLiveProject?.title || 'l’autre production' }} » </template>vers la plateforme va s’arrêter. Une prise en cours et le retour de la salle continueront.</p></ConfirmDialog>
</template>
