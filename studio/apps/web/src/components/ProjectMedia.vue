<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { MediaAsset, MediaMode, MediaRole, ProjectMediaLink } from '@gabin/shared';
import { useStudio } from '../composables/useStudio';
import MediaPreview from './MediaPreview.vue';
import MediaViewer from './MediaViewer.vue';
import Icon from './Icon.vue';
const props = withDefaults(defineProps<{ projectId: string; mode?: 'prepare' | 'regie' }>(), { mode: 'prepare' });
const emit = defineEmits<{ library: []; prepare: [] }>();
const { state, live, canEdit, busy, saveProjectMedia, control } = useStudio();
const selectedAsset = ref('');
const selectedRole = ref<MediaRole>('other');
const saving = ref(false);
const draft = ref<ProjectMediaLink[]>([]);
const preview = ref<MediaAsset | null>(null);
const launchModes = ref<Record<string, MediaMode>>({});
const roles: { id: MediaRole; label: string }[] = [{ id: 'intro', label: 'Introduction' }, { id: 'logo', label: 'Logo' }, { id: 'presentation', label: 'Présentation' }, { id: 'outro', label: 'Générique de fin' }, { id: 'music', label: 'Musique' }, { id: 'other', label: 'Autre média' }];
const roleLabel = (role: MediaRole) => roles.find(item => item.id === role)?.label ?? 'Autre média';
const catalog = computed(() => state.value?.library ?? []);
const assetsById = computed(() => new Map(catalog.value.map(asset => [asset.id, asset])));
const sourceLinks = computed(() => state.value?.projectMedia?.[props.projectId] ?? []);
const available = computed(() => catalog.value.filter(asset => !asset.archivedAt && !draft.value.some(link => link.assetId === asset.id)).sort((a, b) => a.title.localeCompare(b.title, 'fr')));
const writable = computed(() => canEdit.value && live.value && !saving.value);
const controllable = computed(() => canEdit.value && live.value && !!state.value?.obs.connected && !busy.value.control);
const playback = computed(() => state.value?.mediaPlayback);
const activeAsset = computed(() => playback.value ? assetsById.value.get(playback.value.assetId) : undefined);
const playbackKnown = computed(() => live.value && !!state.value?.obs.connected && playback.value?.status !== 'unknown');
const needsReturn = computed(() => !!playback.value?.sceneName && playback.value.mode === 'fullscreen' && state.value?.obs.currentScene === playback.value.sceneName);
const playbackLabel = computed(() => !playbackKnown.value ? 'État à vérifier' : playback.value?.status === 'paused' ? 'En pause' : playback.value?.status === 'shown' ? 'Affiché dans OBS' : playback.value?.status === 'playing' ? 'Lecture en cours' : needsReturn.value ? 'Média terminé' : 'À l’arrêt');
const active = computed(() => !!playback.value && (playback.value.status !== 'stopped' || needsReturn.value));
const stopLabel = computed(() => playback.value?.status === 'stopped' && needsReturn.value ? 'Revenir au plan précédent' : activeAsset.value?.kind === 'image' ? 'Masquer le média' : 'Arrêter le média');
const pauseAvailable = computed(() => activeAsset.value?.kind === 'video' || activeAsset.value?.kind === 'audio');
watch(() => `${props.projectId}:${JSON.stringify(sourceLinks.value)}`, () => { draft.value = [...sourceLinks.value].sort((a, b) => a.order - b.order).map(link => ({ ...link })); }, { immediate: true });
watch(selectedAsset, id => {
  const kind = assetsById.value.get(id)?.kind;
  selectedRole.value = kind === 'document' ? 'presentation' : kind === 'audio' ? 'music' : 'other';
});
function modeFor(link: ProjectMediaLink, asset: MediaAsset): MediaMode {
  if (asset.kind === 'audio') return 'audio';
  return launchModes.value[asset.id] ?? (link.role === 'logo' ? 'overlay' : 'fullscreen');
}
async function persist(links: ProjectMediaLink[]): Promise<void> {
  if (!writable.value) return;
  saving.value = true;
  const saved = await saveProjectMedia(props.projectId, links.map((link, index) => ({ ...link, order: index })));
  draft.value = [...(saved ?? sourceLinks.value)].sort((a, b) => a.order - b.order).map(link => ({ ...link }));
  saving.value = false;
}
async function add(): Promise<void> {
  if (!selectedAsset.value || !available.value.some(asset => asset.id === selectedAsset.value)) return;
  const id = selectedAsset.value;
  await persist([...draft.value, { assetId: id, role: selectedRole.value, order: draft.value.length }]);
  if (draft.value.some(link => link.assetId === id)) selectedAsset.value = '';
}
function reorder(index: number, direction: -1 | 1): void {
  const next = draft.value.map(link => ({ ...link }));
  const target = index + direction;
  if (target < 0 || target >= next.length) return;
  [next[index], next[target]] = [next[target]!, next[index]!];
  void persist(next);
}
function changeRole(index: number, event: Event): void {
  const next = draft.value.map(link => ({ ...link }));
  if (next[index]) next[index]!.role = (event.target as HTMLSelectElement).value as MediaRole;
  void persist(next);
}
function launch(link: ProjectMediaLink): void {
  const asset = assetsById.value.get(link.assetId);
  if (!asset || asset.kind === 'document' || asset.archivedAt || !controllable.value) return;
  void control({ action: 'media.play', assetId: asset.id, projectId: props.projectId, mode: modeFor(link, asset) });
}
</script>

<template>
  <section :class="mode === 'prepare' ? 'project-media-preparation' : 'regie-cues'">
    <header class="project-media-heading"><div><Icon name="library" /><h2>{{ mode === 'prepare' ? 'Médias de cette production' : 'Médias à lancer' }}</h2></div><button v-if="mode === 'prepare'" class="text-button" @click="emit('library')">Ouvrir la bibliothèque</button></header>
    <template v-if="mode === 'prepare'">
      <p class="muted">Associez votre habillage et vos supports. Les fichiers sont conservés sur le PC de la salle.</p>
      <form v-if="canEdit" class="project-media-add" @submit.prevent="add"><label class="field">Média à associer<select v-model="selectedAsset" aria-label="Média à associer" :disabled="!writable"><option value="">Choisir un média de la bibliothèque</option><option v-for="asset in available" :key="asset.id" :value="asset.id">{{ asset.title }}</option></select></label><label class="field">Rôle du média<select v-model="selectedRole" aria-label="Rôle du média" :disabled="!writable"><option v-for="role in roles" :key="role.id" :value="role.id">{{ role.label }}</option></select></label><button class="button" :disabled="!writable || !selectedAsset"><Icon name="plus" />Ajouter le média</button></form>
      <p v-if="!draft.length" class="empty-inline">Aucun média associé. Les fichiers peuvent être ajoutés depuis la bibliothèque.</p>
      <div v-else class="project-media-links"><article v-for="(link, index) in draft" :key="link.assetId" class="project-media-link"><button v-if="assetsById.get(link.assetId)" class="project-media-thumbnail" :aria-label="`Ouvrir ${assetsById.get(link.assetId)!.title}`" @click="preview = assetsById.get(link.assetId)!"><MediaPreview :asset="assetsById.get(link.assetId)!" /></button><div class="project-media-identity"><strong>{{ assetsById.get(link.assetId)?.title || 'Média indisponible' }}</strong><span v-if="assetsById.get(link.assetId)?.archivedAt" class="badge neutral">Archivé · lien conservé</span><span v-else class="hint">{{ assetsById.get(link.assetId)?.originalName }}</span></div><label v-if="canEdit" class="field project-media-role"><span class="sr-only">Rôle de {{ assetsById.get(link.assetId)?.title || 'ce média' }}</span><select :value="link.role" :disabled="!writable" @change="changeRole(index, $event)"><option v-for="role in roles" :key="role.id" :value="role.id">{{ role.label }}</option></select></label><span v-else class="project-media-role-label">{{ roleLabel(link.role) }}</span><div v-if="canEdit" class="project-media-edit"><button class="icon-button" :disabled="!writable || index === 0" :aria-label="`Monter ${assetsById.get(link.assetId)?.title || 'ce média'}`" @click="reorder(index, -1)"><Icon name="up" /></button><button class="icon-button" :disabled="!writable || index === draft.length - 1" :aria-label="`Descendre ${assetsById.get(link.assetId)?.title || 'ce média'}`" @click="reorder(index, 1)"><Icon name="down" /></button><button class="icon-button" :disabled="!writable" :aria-label="`Retirer ${assetsById.get(link.assetId)?.title || 'ce média'} de cette production`" @click="persist(draft.filter(item => item.assetId !== link.assetId))"><Icon name="close" /></button></div></article></div>
      <p v-if="saving" class="hint" role="status">Enregistrement des médias de la production…</p>
      <p v-if="draft.some(link => assetsById.get(link.assetId)?.kind === 'document')" class="hint">Les PDF et PowerPoint sont inclus dans le dossier complet. Préparez leur affichage dans OBS avant de tourner.</p>
    </template>
    <template v-else>
      <div v-if="active" class="regie-media-active"><div><strong>{{ activeAsset?.title || 'Média actif dans le studio' }}</strong><span :class="{ warning: !playbackKnown }">{{ playbackLabel }}</span></div><p v-if="playback?.status === 'stopped' && needsReturn && playbackKnown" class="hint">Le clip est terminé. Revenez au plan précédent quand vous êtes prêt.</p><p v-if="playback?.error" class="hint">{{ playback.error }}</p><div v-if="canEdit" class="regie-media-actions"><button v-if="pauseAvailable && playback?.status === 'playing'" class="button compact" :disabled="!controllable" @click="control({ action: 'media.pause' })"><Icon name="pause" />Mettre le média en pause</button><button v-if="pauseAvailable && playback?.status === 'paused'" class="button compact" :disabled="!controllable" @click="control({ action: 'media.resume' })"><Icon name="play" />Reprendre le média</button><button class="button compact" :disabled="!controllable" @click="control({ action: 'media.stop' })"><Icon name="stop" />{{ stopLabel }}</button></div></div>
      <div v-if="!draft.length" class="regie-media-empty"><p>Ajoutez une introduction, un logo ou une musique à cette production.</p><button class="text-button" @click="emit('prepare')">Choisir les médias</button></div>
      <div v-else class="regie-cue-list"><article v-for="link in draft" :key="link.assetId" class="regie-cue" :class="{ selected: playbackKnown && active && playback?.assetId === link.assetId }"><template v-if="assetsById.get(link.assetId)"><div class="regie-cue-identity"><button class="regie-cue-preview" :aria-label="`Ouvrir ${assetsById.get(link.assetId)!.title}`" @click="preview = assetsById.get(link.assetId)!"><MediaPreview :asset="assetsById.get(link.assetId)!" /></button><div><strong>{{ assetsById.get(link.assetId)!.title }}</strong><span>{{ roleLabel(link.role) }}</span></div></div><label v-if="assetsById.get(link.assetId)!.kind === 'image' || assetsById.get(link.assetId)!.kind === 'video'" class="regie-cue-mode"><span>Affichage</span><select :value="modeFor(link, assetsById.get(link.assetId)!)" :disabled="!canEdit" :aria-label="`Affichage de ${assetsById.get(link.assetId)!.title}`" @change="launchModes[link.assetId] = ($event.target as HTMLSelectElement).value as MediaMode"><option value="fullscreen">Plein écran</option><option value="overlay">Superposition</option></select></label><p v-if="assetsById.get(link.assetId)!.archivedAt" class="hint">Média archivé. Restaurez-le dans la bibliothèque pour le lancer.</p><p v-else-if="assetsById.get(link.assetId)!.kind === 'document'" class="hint">Document à préparer dans OBS.</p><button v-else-if="canEdit" class="button regie-cue-trigger" :disabled="!controllable" :aria-label="`Lancer ${assetsById.get(link.assetId)!.title}`" @click="launch(link)"><Icon name="play" />Lancer</button></template><p v-else class="hint">Ce média n’est plus disponible dans le catalogue.</p></article></div>
    </template>
  </section>
  <MediaViewer :asset="preview" @close="preview = null" />
</template>
