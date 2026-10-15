<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatLabels, type Participant, type ProductionFormat, type Project, type ProjectInput } from '@gabin/shared';
import { newId, useStudio } from '../composables/useStudio';
import Icon from './Icon.vue';
const props = defineProps<{ project?: Project }>();
const emit = defineEmits<{ saved: [project: Project]; cancel: [] }>();
const { state, busy, saveProject } = useStudio();
const draft = ref<ProjectInput>({
  title: props.project?.title ?? '', description: props.project?.description ?? '',
  owner: props.project?.owner ?? '', format: props.project?.format ?? 'roundtable',
  defaultScene: props.project?.defaultScene ?? null,
  participants: props.project?.participants.map(person => ({ ...person })) ?? [],
});
const formats: { id: ProductionFormat; icon: string; text: string }[] = [
  { id: 'podcast', icon: 'mic', text: 'Une émission audio, seul ou à plusieurs.' },
  { id: 'roundtable', icon: 'movie', text: 'Une discussion filmée dans la salle.' },
  { id: 'slides', icon: 'slides', text: 'Un écran, une présentation ou une démonstration commentée.' },
];
const audioInputs = computed(() => state.value?.obs.inputs.filter(input => input.muted !== null) ?? []);
function addParticipant(): void {
  if ((draft.value.participants?.length ?? 0) < 4) draft.value.participants?.push({ id: newId(), name: '', micInput: null, sceneName: null });
}
async function save(): Promise<void> {
  if (!draft.value.title.trim()) return;
  const input = { ...draft.value, title: draft.value.title.trim(), participants: draft.value.participants?.map((person: Participant) => ({ ...person, name: person.name.trim() })) };
  const result = await saveProject(input, props.project?.id);
  if (result) emit('saved', result);
}
</script>

<template>
  <form class="project-form" @submit.prevent="save">
    <section class="form-identity">
      <label class="field form-title-field">Nom de la production <input v-model="draft.title" required maxlength="160" placeholder="Ex. Les métiers de la santé · épisode 01" autocomplete="off" /></label>
      <p class="hint">Ce nom permet de retrouver la production et ses prises après l’enregistrement.</p>
    </section>

    <section class="form-section">
      <div class="form-section-heading"><h2>Quel contenu allez-vous enregistrer ?</h2><p>Le format détermine la scène proposée au démarrage.</p></div>
      <div class="form-section-content">
        <div class="form-format-options">
          <button v-for="format in formats" :key="format.id" type="button" class="form-format-option" :aria-pressed="draft.format === format.id" @click="draft.format = format.id">
            <Icon :name="format.icon" /><span><strong>{{ formatLabels[format.id] }}</strong><small>{{ format.text }}</small></span><Icon v-if="draft.format === format.id" name="check" class="form-format-check" />
          </button>
        </div>
      </div>
    </section>

    <section class="form-section">
      <div class="form-section-heading"><h2>Informations du projet</h2><p>Préparez le sujet et la scène qui accueille les participants.</p></div>
      <div class="form-section-content form-grid">
        <label class="field">Responsable <input v-model="draft.owner" maxlength="100" placeholder="Nom ou équipe" autocomplete="name" /></label>
        <label class="field">Scène affichée au démarrage
          <select v-model="draft.defaultScene"><option :value="null">Profil de la salle</option><option v-for="scene in state?.obs.scenes" :key="scene" :value="scene">{{ scene }}</option><option v-if="draft.defaultScene && !state?.obs.scenes.includes(draft.defaultScene)" :value="draft.defaultScene">{{ draft.defaultScene }} (indisponible)</option></select>
        </label>
        <label class="field full">Description <textarea v-model="draft.description" maxlength="2000" placeholder="Sujet, objectif et consignes pour cette production" rows="3" /></label>
      </div>
    </section>

    <section class="form-section form-participants-section">
      <div class="form-section-heading"><h2>Les personnes dans la salle</h2><p>Associez à chaque personne son micro et son plan OBS.</p><span class="count">{{ draft.participants?.length ?? 0 }} / 4 participants</span></div>
      <div class="form-section-content">
        <div v-if="!draft.participants?.length" class="form-participants-empty"><Icon name="mic" /><p>Ajoutez les personnes qui participent à l’enregistrement.</p></div>
        <div v-else class="form-participant-list">
          <div v-for="(person, index) in draft.participants" :key="person.id" class="participant-form form-participant-row">
            <span class="form-participant-number" aria-hidden="true">{{ index + 1 }}</span>
            <label class="field">Nom <input v-model="person.name" required maxlength="100" :placeholder="`Participant ${index + 1}`" /></label>
            <label class="field">Micro <select v-model="person.micInput"><option :value="null">À associer</option><option v-for="input in audioInputs" :key="input.name" :value="input.name">{{ input.name }}</option><option v-if="person.micInput && !audioInputs.some(input => input.name === person.micInput)" :value="person.micInput">{{ person.micInput }} (indisponible)</option></select></label>
            <label class="field">Plan caméra <select v-model="person.sceneName"><option :value="null">Sans plan associé</option><option v-for="scene in state?.obs.scenes" :key="scene" :value="scene">{{ scene }}</option><option v-if="person.sceneName && !state?.obs.scenes.includes(person.sceneName)" :value="person.sceneName">{{ person.sceneName }} (indisponible)</option></select></label>
            <button type="button" class="icon-button" :aria-label="`Retirer ${person.name || `le participant ${index + 1}`}`" @click="draft.participants?.splice(index, 1)"><Icon name="close" /></button>
          </div>
        </div>
        <div class="form-participant-actions"><button type="button" class="button" :disabled="(draft.participants?.length ?? 0) >= 4" @click="addParticipant"><Icon name="plus" />Ajouter une personne</button><p v-if="!state?.obs.connected" class="hint">Connectez OBS dans les réglages de la salle pour choisir les micros et les plans.</p></div>
      </div>
    </section>

    <div class="form-savebar"><button type="button" class="button" :disabled="busy.project" @click="emit('cancel')">Annuler</button><button class="button primary" :disabled="busy.project || !draft.title.trim()">{{ busy.project ? 'Enregistrement du projet…' : project ? 'Enregistrer le projet' : 'Créer le projet' }}<Icon name="arrow" /></button></div>
  </form>
</template>
