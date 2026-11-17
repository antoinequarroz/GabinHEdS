<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AutoDirectionSettings, Project } from '@nino/shared';
import { useStudio } from '../composables/useStudio';
import Icon from './Icon.vue';

const props = defineProps<{ project: Project }>();
const fieldId = (name: string) => `auto-${props.project.id}-${name}`;
const { state, live, canEdit, busy, control, can, captureName } = useStudio();
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
const remoteParticipants = computed(() => (state.value?.guestRooms?.[props.project.id]?.guests ?? [])
  .filter(guest => guest.admitted && guest.mediaReady && guest.sourceReady && !guest.muted)
  .map(guest => ({ id: guest.id, name: `${guest.name} (à distance)`, micInput: guest.inputName, sceneName: guest.sceneName })));
const participants = computed(() => [...props.project.participants, ...remoteParticipants.value]);
const otherProduction = computed(() => automatic.value?.enabled && !own.value
  || state.value?.activeTake && state.value.activeTake.projectId !== props.project.id
  || state.value?.liveProjectId && state.value.liveProjectId !== props.project.id);
const editable = computed(() => live.value && canEdit.value && !busy.value.control && !enabled.value);
const invalid = computed(() => {
  const people = participants.value;
  const obs = state.value?.obs;
  if (!people.length) return 'Ajoutez au moins une personne et associez son micro et son plan dans la production.';
  if (people.some(person => !person.micInput || !person.sceneName)) return 'Associez un micro et un plan à chaque personne dans « Modifier ».';
  if (new Set(people.map(person => person.micInput)).size !== people.length) return 'Chaque personne doit avoir un micro ou canal audio distinct.';
  if (new Set(people.map(person => person.sceneName)).size !== people.length) return 'Associez un plan distinct à chaque personne.';
  if (!draft.value.wideScene || !obs?.scenes.includes(draft.value.wideScene)) return 'Choisissez un plan large présent dans OBS.';
  if (new Set([...people.map(person => person.sceneName), draft.value.wideScene]).size < 2) return 'Le plan large et le plan de la personne doivent être différents.';
  if (people.some(person => !obs?.scenes.includes(person.sceneName!) || !obs?.inputs.some(input => input.name === person.micInput && input.muted !== null))) return 'Un plan ou un micro associé est absent d’OBS. Vérifiez les sources de la salle.';
  if (people.some(person => obs?.inputs.find(input => input.name === person.micInput)?.muted)) return 'Un micro est coupé. Réactivez les micros avant de reprendre l’automatique.';
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
    <div class="auto-associations"><div v-for="person in participants" :key="person.id" :class="{ speaking: enabled && automatic?.participantId === person.id }"><span class="auto-person">{{ person.name }}</span><small>{{ person.micInput || 'Micro à associer' }} <span aria-hidden="true">→</span> {{ person.sceneName || 'Plan à associer' }}</small></div></div>
    <p v-if="state?.guestRooms?.[project.id]?.guests.some(guest => guest.status !== 'removed')" class="hint">Les invités rejoignent l’automatique après leur admission et la réception de leur vidéo dans OBS. Un invité muet ou déconnecté est écarté.</p>
    <div class="field"><label :for="fieldId('wide')">Plan large</label><select :id="fieldId('wide')" v-model="draft.wideScene" :disabled="!editable"><option value="">Choisir un plan</option><option v-for="scene in state?.obs.scenes" :key="scene" :value="scene">{{ scene }}</option></select></div>
    <p v-if="own && automatic?.message" class="auto-message" role="status">{{ automatic.message }}</p>
    <p v-if="invalid" class="hint">{{ invalid }}</p>
    <p v-if="!can('audio.meters')" class="hint">{{ captureName }} n’envoie pas encore les niveaux des micros à Nino : la réalisation automatique n’est pas disponible.</p>
    <p v-if="otherProduction" class="hint">Une autre production contrôle la salle. Terminez sa session avant d’activer l’automatique ici.</p>
    <template v-if="canEdit"><button v-if="enabled" class="button auto-trigger" :disabled="!live || busy.control" @click="control({ action: 'auto.stop' })"><Icon name="stop" />Revenir en manuel</button><button v-else class="button primary auto-trigger" :disabled="!editable || !state?.obs.connected || !!invalid || !!otherProduction || !can('audio.meters')" @click="start"><Icon name="camera" />{{ own && automatic?.status === 'suspended' ? 'Reprendre l’automatique' : 'Activer l’automatique' }}</button></template>
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
/* Suite compact card (Cairn/Lamio Card: radius 12, line border, --shadow). */
.auto-direction { flex-shrink: 0; padding: 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
.auto-direction .regie-section-heading { flex-wrap: nowrap; gap: 8px; margin-bottom: 10px; }
.auto-direction .regie-section-heading > div { min-width: 0; }
.auto-direction .regie-section-heading h2 { min-width: 0; overflow-wrap: anywhere; }
.auto-direction .regie-section-heading .regie-status { flex-shrink: 0; }
.auto-intro, .auto-message { color: var(--ink-2); font-size: 13px; line-height: 1.5; margin: 0 0 14px; }
.auto-message { padding: 8px 12px; border: 1px solid color-mix(in oklab, var(--accent) 30%, transparent); border-radius: 8px; background: color-mix(in oklab, var(--accent-soft) 40%, var(--surface)); font-size: 12.5px; margin-top: 12px; }
.auto-associations { display: grid; gap: 4px; margin-bottom: 14px; }
.auto-associations:empty { display: none; }
.auto-associations > div { padding: 8px 12px; border-radius: 8px; background: var(--surface-2); display: grid; gap: 2px; min-width: 0; transition: background-color 150ms cubic-bezier(.4, 0, .2, 1); }
.auto-associations .speaking { background: var(--accent-soft); }
.auto-person { font-size: 13px; font-weight: 500; color: var(--ink); }
.auto-associations .speaking .auto-person { color: var(--accent-text); }
.auto-associations small { font-size: 12px; color: var(--ink-3); overflow-wrap: anywhere; }
.auto-trigger { width: 100%; margin-top: 12px; white-space: normal; }
.auto-settings-fields { display: grid; gap: 12px; margin: 12px 0 4px; }
.auto-settings-fields small { font-size: 11.5px; font-weight: 400; color: var(--ink-3); line-height: 1.5; }
</style>
