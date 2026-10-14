<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatLabels, type Project, type Take } from '@gabin/shared';
import { useStudio } from '../composables/useStudio';
import Icon from '../components/Icon.vue';
import TakePoster from '../components/TakePoster.vue';
const emit = defineEmits<{ navigate: [path: string] }>();
const { state, live, canEdit } = useStudio();
const query = ref('');
const filter = ref<'all' | 'draft' | 'completed'>('all');
const sortedProjects = computed(() => [...(state.value?.projects ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
const latestProject = computed(() => {
  const currentId = state.value?.activeTake?.projectId ?? state.value?.liveProjectId;
  return sortedProjects.value.find(project => project.id === currentId) ?? sortedProjects.value.find(project => project.status !== 'archived') ?? sortedProjects.value[0];
});
const projects = computed(() => sortedProjects.value.filter(project => (filter.value === 'all' || project.status === filter.value) && `${project.title} ${project.owner}`.toLocaleLowerCase('fr').includes(query.value.toLocaleLowerCase('fr'))));
const filters = computed(() => [
  { id: 'all' as const, label: 'Toutes', count: sortedProjects.value.length },
  { id: 'draft' as const, label: 'À préparer', count: sortedProjects.value.filter(project => project.status === 'draft').length },
  { id: 'completed' as const, label: 'Terminées', count: sortedProjects.value.filter(project => project.status === 'completed').length },
]);
const statusLabels: Record<Project['status'], string> = { draft: 'À préparer', ready: 'Prêt', recording: 'Enregistrement', completed: 'Terminé', archived: 'Archivé' };
function displayStatus(project: Project): { label: string; className: string } {
  if (project.status !== 'recording') return { label: statusLabels[project.status], className: `status-${project.status}` };
  const obs = state.value?.obs;
  const confirmed = live.value && obs?.connected && obs.recording && state.value?.activeTake?.projectId === project.id;
  if (!confirmed) return { label: 'État à vérifier', className: 'status-unknown' };
  return obs.paused ? { label: 'En pause', className: 'status-unknown' } : { label: 'Enregistrement', className: 'status-recording' };
}
const date = (value: string) => new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
const takeCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const take of state.value?.takes ?? []) counts.set(take.projectId, (counts.get(take.projectId) ?? 0) + 1);
  return counts;
});
const takeCount = (project: Project) => takeCounts.value.get(project.id) ?? 0;
const latestTakes = computed(() => {
  const completed = new Map<string, Take>();
  for (const take of state.value?.takes ?? []) {
    if (take.status !== 'completed' || !take.outputPath) continue;
    const previous = completed.get(take.projectId);
    if (!previous || take.startedAt > previous.startedAt) completed.set(take.projectId, take);
  }
  return completed;
});
const posterTake = (project: Project) => latestTakes.value.get(project.id);
function takeDuration(take: Take): string {
  const seconds = Math.floor(take.durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
const formatIcon = (project: Project) => project.format === 'podcast' ? 'mic' : project.format === 'slides' ? 'slides' : 'movie';
</script>

<template>
  <div class="library-page">
    <div class="library-heading"><div><h1>Vos productions</h1><p>Tout ce que vous préparez et enregistrez dans la salle.</p></div><button v-if="canEdit" class="button primary" @click="emit('navigate', 'new')"><Icon name="plus" />Nouvelle production</button></div>
    <section v-if="!state?.projects.length" class="library-empty">
      <span class="library-empty-symbol"><Icon name="projects" /></span><div><h2>Créez votre première production</h2><p>Podcast, table ronde ou présentation : commencez par le nom et les participants.</p><button v-if="canEdit" class="button primary" @click="emit('navigate', 'new')">Créer une production<Icon name="arrow" /></button></div>
    </section>
    <template v-else>
      <section v-if="latestProject" class="library-resume" aria-labelledby="latest-production-title">
        <button class="library-resume-poster" :aria-label="`Ouvrir la production ${latestProject.title}`" @click="emit('navigate', `project/${latestProject.id}`)">
          <TakePoster v-if="posterTake(latestProject)" :take-id="posterTake(latestProject)!.id" />
          <span v-else class="library-poster-empty"><Icon :name="formatIcon(latestProject)" /><span>{{ formatLabels[latestProject.format] }}</span></span>
          <span class="library-poster-play" aria-hidden="true"><Icon name="play" /></span>
          <span v-if="posterTake(latestProject)" class="library-poster-duration">{{ takeDuration(posterTake(latestProject)!) }}</span>
        </button>
        <div class="library-resume-content"><div class="library-resume-label"><span class="library-row-status" :class="displayStatus(latestProject).className">{{ displayStatus(latestProject).label }}</span><span class="library-resume-date">{{ date(latestProject.updatedAt) }}</span></div><h2 id="latest-production-title">{{ latestProject.title }}</h2><p v-if="latestProject.description" class="library-resume-description">{{ latestProject.description }}</p><div class="library-resume-meta"><span>{{ formatLabels[latestProject.format] }}</span><span v-if="latestProject.owner">{{ latestProject.owner }}</span></div><p class="library-resume-details">{{ latestProject.participants.length }} participant{{ latestProject.participants.length === 1 ? '' : 's' }} · {{ takeCount(latestProject) }} prise{{ takeCount(latestProject) === 1 ? '' : 's' }}</p><button class="button primary" @click="emit('navigate', `project/${latestProject.id}`)">Reprendre la production<Icon name="arrow" /></button></div>
      </section>
      <section class="library-list" aria-label="Liste des productions">
        <div class="library-list-toolbar"><div class="library-filter-tabs" role="group" aria-label="Filtrer les productions"><button v-for="item in filters" :key="item.id" :aria-pressed="filter === item.id" @click="filter = item.id">{{ item.label }}<span>{{ item.count }}</span></button></div><label class="library-search"><span class="sr-only">Rechercher une production</span><input v-model="query" type="search" placeholder="Rechercher une production" /></label></div>
        <div v-if="!projects.length" class="library-no-results">Aucune production ne correspond à cette recherche.</div>
        <div class="library-grid">
          <button v-for="project in projects" :key="project.id" class="library-card project-row" :aria-label="project.title" @click="emit('navigate', `project/${project.id}`)">
            <span class="library-card-poster">
              <TakePoster v-if="posterTake(project)" :take-id="posterTake(project)!.id" />
              <span v-else class="library-poster-empty"><Icon :name="formatIcon(project)" /><span>{{ formatLabels[project.format] }}</span></span>
              <span class="library-poster-play" aria-hidden="true"><Icon name="arrow" /></span>
              <span v-if="posterTake(project)" class="library-poster-duration">{{ takeDuration(posterTake(project)!) }}</span>
            </span>
            <span class="library-card-body">
              <span class="library-card-topline"><span>{{ formatLabels[project.format] }}</span><span class="library-row-status" :class="displayStatus(project).className">{{ displayStatus(project).label }}</span></span>
              <strong class="library-card-title">{{ project.title }}</strong>
              <span v-if="project.owner" class="library-card-meta">{{ project.owner }}</span>
              <span class="library-card-footer"><span>{{ takeCount(project) }} prise{{ takeCount(project) === 1 ? '' : 's' }}</span><time :datetime="project.updatedAt"><span class="sr-only">Modifié le </span>{{ date(project.updatedAt) }}</time></span>
            </span>
          </button>
        </div>
      </section>
    </template>
  </div>
</template>
