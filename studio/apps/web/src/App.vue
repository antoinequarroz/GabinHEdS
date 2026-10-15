<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useStudio } from './composables/useStudio';
import Icon from './components/Icon.vue';
import ProjectForm from './components/ProjectForm.vue';
import ProjectsPage from './pages/ProjectsPage.vue';
import ProjectPage from './pages/ProjectPage.vue';
import RoomPage from './pages/RoomPage.vue';
import DevicesPage from './pages/DevicesPage.vue';
import LibraryPage from './pages/LibraryPage.vue';
import StudioBrand from './components/StudioBrand.vue';
import GuestPage from './pages/GuestPage.vue';
import GuestBridgePage from './pages/GuestBridgePage.vue';
import GuestSourcePage from './pages/GuestSourcePage.vue';
const { device, state, initialized, live, busy, error, notice, technician, canEdit, initialize, pair, forgetDevice, refresh, suspendStudioConnection } = useStudio();
const path = ref(location.hash.slice(1) || 'projects');
const gateway = ref<'checking' | 'studio' | 'guest'>('checking');
const guestRoute = computed(() => /^(guest|guest-source)\//.test(path.value) || path.value === 'guest-bridge' || location.pathname === '/guest-bridge');
const invitationToken = computed(() => path.value.startsWith('guest/') ? path.value.slice(6) : '');
const sourceToken = computed(() => path.value.startsWith('guest-source/') ? path.value.slice(13) : '');
const bridgeRoute = computed(() => path.value === 'guest-bridge' || location.pathname === '/guest-bridge');
const code = ref('');
const deviceName = ref('iPad de la salle');
const localPc = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const selectedProject = computed(() => state.value?.projects.find(project => `project/${project.id}` === path.value));
const deviceRole = computed(() => device.value?.role === 'viewer' ? 'Consultation' : device.value?.role === 'operator' ? 'Contrôle' : 'Configuration');
const recordingIndicator = computed(() => {
  const obs = state.value?.obs;
  if (!live.value || !obs?.connected) return { label: 'État à vérifier', status: 'is-warning' };
  if (obs.recording) return { label: obs.paused ? 'En pause' : 'OBS enregistre', status: obs.paused ? 'is-warning' : 'is-active' };
  return { label: 'À l’arrêt', status: 'is-idle' };
});
const liveIndicator = computed(() => {
  if (!live.value) return { label: 'État à vérifier', status: 'is-warning' };
  const status = state.value?.media.liveStatus;
  if (status === 'live') return state.value?.obs.connected
    ? { label: 'Flux envoyé', status: 'is-active' }
    : { label: 'Source OBS déconnectée', status: 'is-warning' };
  if (status === 'starting') return { label: 'Connexion', status: 'is-warning' };
  if (status === 'stopping') return { label: 'Arrêt en cours', status: 'is-warning' };
  if (status === 'error') return { label: 'Interrompu', status: 'is-warning' };
  return { label: 'À l’arrêt', status: 'is-idle' };
});
const currentSection = computed(() => ['room', 'devices', 'library'].includes(path.value) ? path.value : 'projects');
const nav = computed(() => [{ id: 'projects', label: 'Productions', icon: 'projects' }, { id: 'library', label: 'Bibliothèque', icon: 'library' }, ...(technician.value ? [{ id: 'room', label: 'Salle et OBS', icon: 'room' }, { id: 'devices', label: 'Appareils', icon: 'devices' }] : [])]);
function navigate(next: string): void { path.value = next; location.hash = next; window.scrollTo({ top: 0, behavior: 'instant' }); }
function onHash(): void { path.value = location.hash.slice(1) || 'projects'; if (guestRoute.value || gateway.value === 'guest') suspendStudioConnection(); else if (gateway.value === 'studio') void initialize(); }
onMounted(async () => {
  window.addEventListener('hashchange', onHash);
  if (guestRoute.value) { gateway.value = 'guest'; suspendStudioConnection(); return; }
  try { const response = await fetch('/api/guest/config'); const config = await response.json() as { mode?: string }; gateway.value = config.mode === 'guest' ? 'guest' : 'studio'; }
  catch { gateway.value = 'studio'; }
  if (gateway.value === 'studio') void initialize(); else suspendStudioConnection();
});
onBeforeUnmount(() => window.removeEventListener('hashchange', onHash));
</script>

<template>
  <GuestSourcePage v-if="sourceToken" :key="sourceToken" :token="sourceToken" />
  <GuestPage v-else-if="invitationToken" :key="invitationToken" :token="invitationToken" />
  <GuestBridgePage v-else-if="bridgeRoute" />
  <div v-else-if="gateway !== 'studio'" class="guest-layout"><header class="guest-header"><StudioBrand /><span>Invités à distance</span></header><main class="guest-main"><div class="guest-heading"><h1>{{ gateway === 'checking' ? 'Connexion au studio…' : 'Votre invitation vous attend' }}</h1><p>{{ gateway === 'checking' ? 'Vérification de l’accès.' : 'Ouvrez le lien personnel envoyé par la salle pour rejoindre votre conversation.' }}</p></div></main></div>
  <template v-else>
  <a v-if="device && state" class="skip-link" href="#main-content">Aller au contenu</a>
  <div v-if="!device || !state" class="login-layout">
    <section class="login-intro"><div class="brand"><StudioBrand /></div><div><h1>La salle est prête.<br />À vous de créer.</h1><p>Préparez votre production et retrouvez la régie de la salle sur le PC ou l’iPad.</p></div><p class="login-footnote">Le PC conserve les enregistrements, même lorsque l’iPad se déconnecte.</p></section>
    <main class="login-form">
      <div v-if="!initialized || busy.auth" class="stack"><span class="spinner" aria-hidden="true"></span><h2>Connexion au studio…</h2><p class="muted">Vérification de l’accès à la salle.</p></div>
      <form v-else class="stack" @submit.prevent="pair(code.trim(), deviceName.trim())"><h1>Rejoindre la salle</h1><p class="muted">Créez un code d’association depuis le PC de la salle, dans « Appareils », puis saisissez-le ici.</p><label class="field">Nom de cet appareil<input v-model="deviceName" required maxlength="100" autocomplete="off" /></label><label class="field">Code d’association<input v-model="code" class="pairing-input" required maxlength="12" inputmode="numeric" autocomplete="one-time-code" placeholder="Code affiché sur le PC" /></label><button class="button primary" :disabled="!code.trim() || !deviceName.trim()">Rejoindre la salle<Icon name="arrow" /></button><button v-if="localPc" type="button" class="button" @click="initialized = false; initialize()">Réessayer la connexion du PC</button></form>
      <p v-if="error" class="banner error" role="alert">{{ error }}</p>
    </main>
  </div>
  <div v-else class="studio-app" :class="{ 'studio-app-production': selectedProject }">
    <header class="studio-topbar topbar">
      <button class="studio-brand" aria-label="Nino, voir les productions" @click="navigate('projects')"><StudioBrand /></button>
      <div class="studio-room" :class="{ 'is-offline': !live || !state.obs.connected }"><span class="status-dot" :class="{ disconnected: !live || !state.obs.connected }"></span><span><strong>{{ state.room.name }}</strong><small>{{ !live ? 'OBS · état à vérifier' : state.obs.connected ? 'OBS connecté' : state.obs.connecting ? 'Connexion à OBS…' : 'OBS déconnecté' }}</small></span></div>
      <div class="studio-transport-status" aria-label="État de la production" aria-live="polite">
        <span class="studio-status-item" :class="recordingIndicator.status"><span class="studio-status-light" aria-hidden="true"></span><strong>REC</strong><span>{{ recordingIndicator.label }}</span></span>
        <span class="studio-status-item" :class="liveIndicator.status"><span class="studio-status-light" aria-hidden="true"></span><strong>LIVE</strong><span>{{ liveIndicator.label }}</span></span>
      </div>
      <div class="studio-device"><Icon name="devices" /><span>{{ device.name }}<small>{{ deviceRole }}</small></span></div>
    </header>
    <div class="studio-workspace"><aside class="studio-rail sidebar"><nav class="studio-nav" aria-label="Navigation principale"><button v-for="item in nav" :key="item.id" :aria-label="item.label" :aria-current="currentSection === item.id ? 'page' : undefined" @click="navigate(item.id)"><Icon :name="item.icon" /><span>{{ item.label }}</span></button></nav><div class="studio-rail-footer"><span class="studio-sync" :class="{ 'is-offline': !live }"><span class="status-dot" :class="{ disconnected: !live }"></span>{{ live ? 'Connecté' : 'Reconnexion' }}</span><details class="studio-access"><summary :aria-label="`Accès de cet appareil : ${deviceRole}`"><Icon name="settings" /><span>Accès de cet appareil</span></summary><div><strong>{{ device.name }}</strong><span>{{ deviceRole }}</span><button class="text-button" @click="forgetDevice">Oublier cet appareil</button></div></details></div></aside>
      <main id="main-content" class="studio-main" tabindex="-1">
        <div v-if="!live" class="banner warning sync-banner" role="status"><Icon name="warning" /><span>Synchronisation interrompue. Les commandes sont suspendues jusqu’à la reconnexion.</span><button class="button compact" :disabled="busy.refresh" @click="refresh">Actualiser</button></div>
        <div v-if="error" class="banner error" role="alert"><span class="grow">{{ error }}</span><button class="icon-button" aria-label="Fermer le message d’erreur" @click="error = ''"><Icon name="close" /></button></div>
        <ProjectsPage v-if="path === 'projects'" @navigate="navigate" />
        <LibraryPage v-else-if="path === 'library'" />
        <template v-else-if="path === 'new' && canEdit"><div class="page-heading"><div><h1>Nouvelle production</h1><p>Donnez un vrai nom à votre contenu et préparez ses participants.</p></div></div><ProjectForm @saved="project => navigate(`project/${project.id}`)" @cancel="navigate('projects')" /></template>
        <ProjectPage v-else-if="selectedProject" :key="selectedProject.id" :project="selectedProject" @navigate="navigate" />
        <RoomPage v-else-if="path === 'room' && technician" />
        <DevicesPage v-else-if="path === 'devices' && technician" />
        <section v-else class="surface empty-state"><h1>Cette page n’est pas disponible</h1><p>Retournez aux productions pour poursuivre.</p><button class="button primary" @click="navigate('projects')">Voir les productions</button></section>
      </main>
    </div>
    <nav class="studio-touch-nav tablet-nav" aria-label="Navigation tactile"><button v-for="item in nav" :key="item.id" :aria-label="item.label" :aria-current="currentSection === item.id ? 'page' : undefined" @click="navigate(item.id)"><Icon :name="item.icon" /><span>{{ item.label }}</span></button><details class="studio-touch-access"><summary><Icon name="settings" /><span>Accès</span></summary><div><strong>{{ device.name }}</strong><span>{{ deviceRole }}</span><button class="text-button" @click="forgetDevice">Oublier cet appareil</button></div></details></nav>
    <div v-if="notice" class="toast" role="status" aria-live="polite"><Icon name="check" />{{ notice }}</div>
  </div>
  </template>
</template>
