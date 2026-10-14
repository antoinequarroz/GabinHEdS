<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AutoDirectionSettings, Project } from '@gabin/shared';
import { useStudio } from '../composables/useStudio';
import Icon from './Icon.vue';

const props = defineProps<{ project: Project }>();
const fieldId = (name: string) => `auto-${props.project.id}-${name}`;
const { state, live, canEdit, busy, control } = useStudio();
const saved = computed(() => state.value?.autoDirectionSettings?.[props.project.id]);
function initialSettings(): AutoDirectionSettings {
  return { wideScene: state.value?.obs.scenes.includes('Plan large') ? 'Plan large' : props.project.defaultScene ?? '',
    thresholdDb: -38, dominanceDb: 6, confirmationMs: 600, minShotMs: 3000, silenceMs: 5000, overlapMs: 1000 };
}
const draft = ref<AutoDirectionSettings>({ ...saved.value ?? initialSettings() });
watch(() => props.project.id, () => { draft.value = { ...saved.value ?? initialSettings() }; });
watch(() => JSON.stringify(saved.value), () => { if (saved.value) draft.value = { ...saved.value }; });
const changed = computed(() => !saved.value || JSON.stringify(draft.value) !== JSON.stringify(saved.value));
const automatic = computed(() => state.value?.autoDirection);
const own = computed(() => automatic.value?.projectId === props.project.id);
const enabled = computed(() => own.value && automatic.value?.enabled);
const otherProduction = computed(() => automatic.value?.enabled && !own.value
  || state.value?.activeTake && state.value.activeTake.projectId !== props.project.id
  || state.value?.liveProjectId && state.value.liveProjectId !== props.project.id);
const editable = computed(() => live.value && canEdit.value && !busy.value.control && !enabled.value);
const invalid = computed(() => {
  const participants = props.project.participants;
  const obs = state.value?.obs;
  if (!participants.length) return 'Ajoutez au moins une personne et associez son micro et son plan dans la production.';
  if (participants.some(person => !person.micInput || !person.sceneName)) return 'Associez un micro et un plan à chaque personne dans « Modifier ».';
  if (new Set(participants.map(person => person.micInput)).size !== participants.length) return 'Chaque personne doit avoir un micro ou canal audio distinct.';
  if (new Set(participants.map(person => person.sceneName)).size !== participants.length) return 'Associez un plan distinct à chaque personne.';
  if (!draft.value.wideScene || !obs?.scenes.includes(draft.value.wideScene)) return 'Choisissez un plan large présent dans OBS.';
  if (new Set([...participants.map(person => person.sceneName), draft.value.wideScene]).size < 2) return 'Le plan large et le plan de la personne doivent être différents.';
  if (participants.some(person => !obs?.scenes.includes(person.sceneName!) || !obs?.inputs.some(input => input.name === person.micInput && input.muted !== null))) return 'Un plan ou un micro associé est absent d’OBS. Vérifiez les sources de la salle.';
  if (participants.some(person => obs?.inputs.find(input => input.name === person.micInput)?.muted)) return 'Un micro est coupé. Réactivez les micros avant de reprendre l’automatique.';
  const bounds: [keyof AutoDirectionSettings, number, number][] = [['thresholdDb', -60, -10], ['dominanceDb', 3, 20], ['confirmationMs', 300, 3000], ['minShotMs', 1000, 15000], ['silenceMs', 1500, 15000], ['overlapMs', 300, 5000]];
  if (bounds.some(([key, min, max]) => typeof draft.value[key] !== 'number' || !Number.isFinite(draft.value[key]) || Number(draft.value[key]) < min || Number(draft.value[key]) > max || !Number.isInteger(Number(draft.value[key])))) return 'Vérifiez les valeurs des réglages avancés et leurs limites.';
  return '';
});
const label = computed(() => !live.value || !state.value?.obs.connected ? 'État à vérifier'
  : own.value ? enabled.value && automatic.value?.status === 'listening' ? 'À l’écoute' : enabled.value && automatic.value?.status === 'waiting' ? 'En attente'
    : automatic.value?.status === 'suspended' ? 'Manuel' : automatic.value?.status === 'error' ? 'À vérifier' : 'Manuel' : 'Manuel');
async function save(): Promise<boolean> {
  if (invalid.value || !editable.value) return false;
  return control({ action: 'auto.configure', projectId: props.project.id, settings: { ...draft.value } });
}
async function start(): Promise<void> {
  if (changed.value && !await save()) return;
  await control({ action: 'auto.start', projectId: props.project.id });
}
</script>

<template>
  <section class="auto-direction" aria-label="Réalisation automatique">
    <header class="regie-section-heading"><div><Icon name="camera" /><h2>Réalisation automatique</h2></div><span class="regie-status" :class="enabled && live ? 'active' : 'idle'" role="status">{{ label }}</span></header>
    <p class="auto-intro">Le micro qui parle choisit son plan. Le silence et les voix simultanées ramènent au plan large.</p>
    <div class="auto-associations"><div v-for="person in project.participants" :key="person.id" :class="{ speaking: enabled && automatic?.participantId === person.id }"><span class="auto-person">{{ person.name }}</span><small>{{ person.micInput || 'Micro à associer' }} <span aria-hidden="true">→</span> {{ person.sceneName || 'Plan à associer' }}</small></div></div>
    <div class="field"><label :for="fieldId('wide')">Plan large</label><select :id="fieldId('wide')" v-model="draft.wideScene" :disabled="!editable"><option value="">Choisir un plan</option><option v-for="scene in state?.obs.scenes" :key="scene" :value="scene">{{ scene }}</option></select></div>
    <p v-if="own && automatic?.message" class="auto-message" role="status">{{ automatic.message }}</p>
    <p v-if="invalid" class="hint">{{ invalid }}</p>
    <p v-if="otherProduction" class="hint">Une autre production contrôle la salle. Terminez sa session avant d’activer l’automatique ici.</p>
    <template v-if="canEdit"><button v-if="enabled" class="button auto-trigger" :disabled="!live || busy.control" @click="control({ action: 'auto.stop' })"><Icon name="stop" />Revenir en manuel</button><button v-else class="button primary auto-trigger" :disabled="!editable || !state?.obs.connected || !!invalid || !!otherProduction" @click="start"><Icon name="camera" />{{ own && automatic?.status === 'suspended' ? 'Reprendre l’automatique' : 'Activer l’automatique' }}</button></template>
    <details class="regie-help auto-settings"><summary>Réglages de détection</summary><div class="auto-settings-fields">
      <div class="field"><label :for="fieldId('thresholdDb')">Seuil des micros (dB)</label><input :id="fieldId('thresholdDb')" v-model.number="draft.thresholdDb" type="number" min="-60" max="-10" step="1" :disabled="!editable" /><small>De −60 à −10 dB. Une voix doit dépasser ce seuil.</small></div>
      <div class="field"><label :for="fieldId('dominanceDb')">Écart entre les micros (dB)</label><input :id="fieldId('dominanceDb')" v-model.number="draft.dominanceDb" type="number" min="3" max="20" step="1" :disabled="!editable" /><small>De 3 à 20 dB pour isoler la voix dominante.</small></div>
      <div class="field"><label :for="fieldId('confirmationMs')">Confirmation de parole (ms)</label><input :id="fieldId('confirmationMs')" v-model.number="draft.confirmationMs" type="number" min="300" max="3000" step="100" :disabled="!editable" /></div>
      <div class="field"><label :for="fieldId('minShotMs')">Durée minimale d’un plan (ms)</label><input :id="fieldId('minShotMs')" v-model.number="draft.minShotMs" type="number" min="1000" max="15000" step="100" :disabled="!editable" /></div>
      <div class="field"><label :for="fieldId('silenceMs')">Retour au plan large après silence (ms)</label><input :id="fieldId('silenceMs')" v-model.number="draft.silenceMs" type="number" min="1500" max="15000" step="100" :disabled="!editable" /></div>
      <div class="field"><label :for="fieldId('overlapMs')">Confirmation des voix simultanées (ms)</label><input :id="fieldId('overlapMs')" v-model.number="draft.overlapMs" type="number" min="300" max="5000" step="100" :disabled="!editable" /></div>
      <button v-if="canEdit" class="button" :disabled="!editable || !changed || !!invalid" @click="save">Enregistrer la détection</button>
    </div></details>
    <details class="regie-help"><summary>Préparer les micros pour l’automatique</summary><p>Utilisez un micro distinct par personne. Les sources audio doivent rester actives dans toutes les scènes OBS. Nino analyse les niveaux localement, sans transcription ni clé IA. Choisir un plan manuellement suspend l’automatique ; sa reprise est explicite.</p></details>
  </section>
</template>

<style scoped>
.auto-direction { flex-shrink: 0; padding: 20px 18px; background: rgba(32, 32, 40, .75); border: 1px solid #ffffff08; border-radius: 15px; }
.auto-direction .regie-section-heading { flex-wrap: wrap; gap: 8px; }
.auto-intro, .auto-message { color: var(--muted, #a3a4b1); font-size: 12px; line-height: 1.65; margin: 14px 0; }
.auto-message { padding-left: 10px; border-left: 2px solid #8c91bb; }
.auto-associations { display: grid; gap: 6px; margin-bottom: 16px; }
.auto-associations > div { padding: 9px 10px; border-radius: 6px; background: #ffffff04; display: grid; gap: 3px; min-width: 0; }
.auto-associations .speaking { background: #9ea2da16; box-shadow: inset 2px 0 #a1a5df; }
.auto-person { font-size: 12px; font-weight: 650; }
.auto-associations small { font-size: 11px; color: var(--muted, #a3a4b1); overflow-wrap: anywhere; }
.auto-trigger { width: 100%; margin-top: 12px; white-space: normal; }
.auto-settings-fields { display: grid; gap: 14px; margin: 16px 0; }
.auto-settings-fields small { font-size: 11px; color: var(--muted, #a3a4b1); line-height: 1.5; }
</style>
