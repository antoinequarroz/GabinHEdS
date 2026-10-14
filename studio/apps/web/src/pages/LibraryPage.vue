<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MediaAsset, MediaKind } from '@gabin/shared';
import { useStudio } from '../composables/useStudio';
import Icon from '../components/Icon.vue';
import MediaPreview from '../components/MediaPreview.vue';
import MediaViewer from '../components/MediaViewer.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
const { state, canEdit, live, error, uploadMedia, updateMedia } = useStudio();
const query = ref('');
const category = ref<MediaKind | 'all'>('all');
const archived = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const preview = ref<MediaAsset | null>(null);
const renaming = ref<MediaAsset | null>(null);
const renameTitle = ref('');
const updating = ref('');
const uploading = ref(false);
const imports = ref<{ name: string; progress: number; status: 'waiting' | 'uploading' | 'done' | 'failed'; error: string }[]>([]);
const kindLabels: Record<MediaKind, string> = { image: 'Image', video: 'Vidéo', audio: 'Audio', document: 'Document' };
const categories: { id: MediaKind | 'all'; label: string; icon: string }[] = [{ id: 'all', label: 'Tous', icon: 'library' }, { id: 'image', label: 'Images', icon: 'image' }, { id: 'video', label: 'Vidéos', icon: 'movie' }, { id: 'audio', label: 'Audio', icon: 'audio' }, { id: 'document', label: 'Documents', icon: 'document' }];
const catalog = computed(() => state.value?.library ?? []);
const currentAssets = computed(() => catalog.value.filter(asset => !!asset.archivedAt === archived.value));
const assets = computed(() => currentAssets.value.filter(asset => (category.value === 'all' || asset.kind === category.value) && `${asset.title} ${asset.originalName}`.toLocaleLowerCase('fr').includes(query.value.trim().toLocaleLowerCase('fr'))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const completedImports = computed(() => imports.value.filter(item => item.status === 'done').length);
const writable = computed(() => canEdit.value && live.value && !uploading.value && !updating.value);
function size(value: number): string { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} Go` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} Mo` : `${Math.max(1, Math.ceil(value / 1024))} Ko`; }
function date(value: string): string { return new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)); }
function duration(value: number | null): string { if (value === null) return ''; const seconds = Math.floor(value / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
async function importFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length || !writable.value) return;
  imports.value = files.map(file => ({ name: file.name, progress: 0, status: 'waiting', error: '' }));
  uploading.value = true;
  for (let index = 0; index < files.length; index++) {
    const item = imports.value[index]!;
    item.status = 'uploading';
    const result = await uploadMedia(files[index]!, undefined, progress => { item.progress = Math.max(0, Math.min(100, progress)); });
    if (result) { item.progress = 100; item.status = 'done'; }
    else { item.status = 'failed'; item.error = error.value || 'L’import n’a pas pu être confirmé. Réessayez ce fichier.'; }
  }
  uploading.value = false;
}
function startRename(asset: MediaAsset): void { renaming.value = asset; renameTitle.value = asset.title; }
async function rename(): Promise<void> {
  const asset = renaming.value;
  if (!asset || !renameTitle.value.trim() || updating.value) return;
  updating.value = asset.id;
  const saved = await updateMedia(asset.id, { title: renameTitle.value.trim() });
  updating.value = '';
  if (saved) renaming.value = null;
}
async function toggleArchive(asset: MediaAsset): Promise<void> {
  if (!writable.value) return;
  updating.value = asset.id;
  await updateMedia(asset.id, { archived: !asset.archivedAt });
  updating.value = '';
}
</script>

<template>
  <div class="media-library-page">
    <header class="library-heading"><div><h1>Bibliothèque de médias</h1><p>Vos introductions, images, musiques et présentations, disponibles pour chaque production.</p></div><button v-if="canEdit" class="button primary" :disabled="!writable" @click="fileInput?.click()"><Icon name="upload" />Ajouter des médias</button><input ref="fileInput" class="sr-only" tabindex="-1" type="file" multiple aria-label="Fichiers à importer" accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.mkv,.webm,.mp3,.wav,.m4a,.aac,.ogg,.flac,.pdf,.pptx" @change="importFiles" /></header>
    <section v-if="imports.length" class="media-imports" aria-label="Progression des imports" aria-live="polite"><header><h2>{{ uploading ? 'Import sur le PC de la salle' : 'Résultat de l’import' }}</h2><span>{{ completedImports }} / {{ imports.length }} fichier(s) importé(s)</span><button v-if="!uploading" class="icon-button" aria-label="Fermer le résultat des imports" @click="imports = []"><Icon name="close" /></button></header><div v-for="(item, index) in imports" :key="index" class="media-import-row"><Icon :name="item.status === 'done' ? 'check' : item.status === 'failed' ? 'warning' : 'upload'" /><div><strong>{{ item.name }}</strong><progress v-if="item.status === 'uploading'" :value="item.progress" max="100" :aria-label="`Import de ${item.name}`"></progress><p>{{ item.status === 'done' ? 'Importé sur le PC' : item.status === 'failed' ? item.error : item.status === 'waiting' ? 'En attente' : item.progress >= 100 ? 'Vérification du fichier sur le PC…' : `${Math.round(item.progress)} % transféré` }}</p></div></div></section>
    <section class="media-catalog" aria-label="Médias de la salle">
      <div class="media-catalog-toolbar"><div class="library-filter-tabs" role="group" aria-label="Statut des médias"><button :aria-pressed="!archived" @click="archived = false">Disponibles<span>{{ catalog.filter(asset => !asset.archivedAt).length }}</span></button><button :aria-pressed="archived" @click="archived = true">Archives<span>{{ catalog.filter(asset => !!asset.archivedAt).length }}</span></button></div><label class="library-search"><span class="sr-only">Rechercher un média</span><input v-model="query" type="search" placeholder="Rechercher un média" /></label></div>
      <div class="media-kind-filters" role="group" aria-label="Type de média"><button v-for="item in categories" :key="item.id" :aria-pressed="category === item.id" @click="category = item.id"><Icon :name="item.icon" />{{ item.label }}<span>{{ currentAssets.filter(asset => item.id === 'all' || asset.kind === item.id).length }}</span></button></div>
      <p v-if="archived" class="hint media-archive-note">Les médias archivés restent liés aux productions existantes. Restaurez-les pour les lancer dans la régie.</p>
      <div v-if="!assets.length" class="media-empty"><Icon name="library" /><h2>{{ query || category !== 'all' ? 'Aucun média ne correspond' : archived ? 'Aucun média archivé' : 'Préparez l’habillage de votre prochaine production' }}</h2><p>{{ query || category !== 'all' ? 'Essayez un autre nom ou un autre type de média.' : archived ? 'Les fichiers archivés apparaîtront ici et pourront être restaurés.' : 'Importez un logo, une introduction, une musique ou votre document de présentation.' }}</p><button v-if="canEdit && !archived && !query && category === 'all'" class="button primary" :disabled="!writable" @click="fileInput?.click()"><Icon name="upload" />Importer le premier média</button></div>
      <div v-else class="media-library-grid"><article v-for="asset in assets" :key="asset.id" class="media-asset-card"><button class="media-asset-open" :aria-label="`Ouvrir ${asset.title}`" @click="preview = asset"><MediaPreview :asset="asset" /><span class="media-kind-badge">{{ kindLabels[asset.kind] }}</span><span v-if="asset.durationMs !== null" class="library-poster-duration">{{ duration(asset.durationMs) }}</span></button><div class="media-asset-copy"><h2>{{ asset.title }}</h2><p class="media-original-name" :title="asset.originalName">{{ asset.originalName }}</p><div class="media-asset-metadata"><span>{{ size(asset.sizeBytes) }}</span><time :datetime="asset.createdAt">{{ date(asset.createdAt) }}</time></div><div v-if="canEdit" class="media-asset-actions"><button class="button compact" :disabled="!writable" :aria-label="`Renommer ${asset.title}`" @click="startRename(asset)"><Icon name="edit" />Renommer</button><button class="button compact" :disabled="!writable" :aria-label="`${asset.archivedAt ? 'Restaurer' : 'Archiver'} ${asset.title}`" @click="toggleArchive(asset)"><Icon :name="asset.archivedAt ? 'restore' : 'archive'" />{{ asset.archivedAt ? 'Restaurer' : 'Archiver' }}</button></div><span v-if="asset.archivedAt" class="badge neutral">Archivé</span></div></article></div>
    </section>
  </div>
  <MediaViewer :asset="preview" @close="preview = null" />
  <ConfirmDialog :open="!!renaming" title="Renommer le média" confirm-label="Enregistrer le nom" busy-label="Enregistrement du nom…" :busy="!!updating" @cancel="renaming = null" @confirm="rename"><label class="field">Nom du média<input v-model="renameTitle" required maxlength="160" /></label><p class="hint">{{ renameTitle.trim() ? 'Le nom du fichier original et les liens avec vos productions sont conservés.' : 'Donnez un nom à ce média pour l’enregistrer.' }}</p></ConfirmDialog>
</template>
