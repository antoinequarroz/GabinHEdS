<template>
  <div class="dashboard-bg min-h-screen">
    <!-- Toolbar / Menubar -->
    <Menubar :model="toolbarItems" class="mb-6 shadow-md dashboard-menubar">
      <template #start>
        <div class="flex items-center gap-3">
          <span class="font-bold text-xl">OneClick Hub</span>
        </div>
      </template>
      <template #end>
        <div class="flex items-center gap-4">
          <i :class="['pi', isConnected ? 'pi-circle-fill text-green-500' : 'pi-circle-fill text-red-500']" style="font-size:1.5rem" title="Connexion Gabin" />
        </div>
      </template>
    </Menubar>

    <!-- Modalités émission -->
    <div class="modality-section grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
      <Card class="col-span-1 modality-card">
        <template #title>
          <div class="flex items-center gap-2">
            <i class="pi pi-sliders-h text-primary text-lg" />
            <span>Modalité vidéo</span>
          </div>
        </template>
        <template #content>
          <Dropdown v-model="selectedModality" :options="modalities" optionLabel="label" placeholder="Choisir une modalité" class="w-full mb-4" @change="onModalityChange" />
          <Dropdown v-model="selectedParticipants" :options="participantsOptions" :disabled="!selectedModality" optionLabel="label" placeholder="Nombre de personnes" class="w-full" />
        </template>
      </Card>
      <Card class="col-span-1 modality-card">
        <template #title>
          <div class="flex items-center gap-2">
            <i class="pi pi-eye text-primary text-lg" />
            <span>Aperçu</span>
          </div>
        </template>
        <template #content>
          <div v-if="selectedModality" class="flex flex-col items-center justify-center">
            <div class="mb-2 flex gap-2">
              <Tag :value="selectedModality.label" class="mr-2" severity="info" />
              <Tag v-if="selectedParticipants" :value="selectedParticipants.label + ' pers.'" severity="success" />
            </div>
            <div class="preview-badge mt-2">
              <span class="preview-type">{{ selectedModality.label }}</span>
              <span v-if="selectedParticipants" class="preview-participants">x{{ selectedParticipants.label }}</span>
            </div>
          </div>
          <div v-else class="text-gray-400 text-center">Sélectionnez une modalité.</div>
        </template>
      </Card>
      <Card class="col-span-1 modality-card">
        <template #title>
          <div class="flex items-center gap-2">
            <i class="pi pi-bolt text-primary text-lg" />
            <span>Actions rapides</span>
          </div>
        </template>
        <template #content>
          <div class="flex flex-col gap-3 items-center">
            <Button label="Appliquer" icon="pi pi-check" class="p-button-success w-full" :disabled="!selectedModality || !selectedParticipants" @click="onApplyModality" />
            <Button label="Réinitialiser" icon="pi pi-refresh" class="p-button-secondary w-full" @click="onResetModality" />
          </div>
        </template>
      </Card>
    </div>

    <!-- Layout principal -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-6 dashboard-main">
      <!-- Colonne gauche -->
      <div class="md:col-span-1 flex flex-col gap-6">
        <Panel header="Studio Status" class="mb-2">
          <div class="flex items-center gap-3 mb-2">
            <i :class="['pi', isRecording ? 'pi-circle-fill text-red-500' : 'pi-circle text-gray-400']" />
            <span class="font-semibold">REC&nbsp;:</span>
            <span :class="isRecording ? 'text-red-500' : 'text-gray-400'">{{ isRecording ? 'ON' : 'OFF' }}</span>
          </div>
          <div class="flex items-center gap-3 mb-2">
            <i class="pi pi-video text-blue-500" />
            <span class="font-semibold">Scène&nbsp;:</span>
            <span>{{ activeScene }}</span>
          </div>
          <div class="flex items-center gap-3">
            <i class="pi pi-volume-up text-green-500" />
            <span class="font-semibold">Audio&nbsp;:</span>
            <ProgressBar :value="audioLevel" :showValue="false" style="width:60%" />
            <span class="w-8 text-right">{{ audioLevel }}%</span>
          </div>
        </Panel>
        <Panel header="Contrôles">
          <div class="flex flex-wrap gap-3 mb-3">
            <Button label="Start Rec" icon="pi pi-circle" class="p-button-success" @click="onStartRec" />
            <Button label="Stop Rec" icon="pi pi-stop" class="p-button-danger" @click="onStopRec" />
          </div>
          <div class="flex flex-wrap gap-3 mb-3">
            <Button label="Start Stream" icon="pi pi-globe" class="p-button-info" @click="onStartStream" />
            <Button label="Stop Stream" icon="pi pi-power-off" class="p-button-warning" @click="onStopStream" />
          </div>
          <div class="flex gap-3 mb-3">
            <SplitButton label="CUT" icon="pi pi-clone" :model="[{label:'FADE', icon:'pi pi-refresh', command:onFade}]" @click="onCut" />
          </div>
          <div class="flex items-center gap-2">
            <span class="font-semibold">T-Bar</span>
            <Slider v-model="tbarValue" :min="0" :max="100" style="width:70%" />
            <span>{{ tbarValue }}</span>
          </div>
        </Panel>
      </div>

      <!-- Colonne centrale -->
      <div class="md:col-span-2 flex flex-col gap-6">
        <Panel header="MultiView">
          <div class="grid grid-cols-2 gap-4">
            <Card v-for="cam in cameras" :key="cam.name" class="p-0 relative cursor-pointer hover:shadow-lg" @click="onSwitchScene(cam.name)">
              <template #content>
                <div class="relative flex items-center justify-center h-32 bg-gray-200 rounded-t">
                  <span class="text-2xl text-gray-500">{{ cam.name }}</span>
                  <div class="absolute top-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded">{{ cam.name }}</div>
                  <i v-if="activeScene === cam.name" class="pi pi-check-circle text-green-400 absolute top-2 right-2 text-xl" />
                </div>
              </template>
            </Card>
          </div>
        </Panel>
        <Panel header="Overlays">
          <div class="flex gap-3 mb-3">
            <Dropdown v-model="selectedOverlay" :options="overlays" optionLabel="label" placeholder="Sélectionner un overlay" class="w-64" />
            <Button label="Appliquer" icon="pi pi-plus" @click="onApplyOverlay" :disabled="!selectedOverlay" />
          </div>
          <DataView :value="activeOverlays" layout="list">
            <template #list="{ data }">
              <div class="flex items-center gap-2 border-b py-2">
                <i class="pi pi-image text-blue-400" />
                <span>{{ data.label }}</span>
                <Button icon="pi pi-times" class="p-button-text p-button-danger ml-auto" @click="onRemoveOverlay(data)" />
              </div>
            </template>
          </DataView>
        </Panel>
      </div>

      <!-- Colonne droite -->
      <div class="md:col-span-1 flex flex-col gap-6">
        <Panel header="Invités">
          <DataTable :value="guests" scrollable scrollHeight="180px">
            <Column field="name" header="Nom" />
            <Column header="Vidéo" body="videoBody" />
            <Column header="Mute" body="muteBody" />
            <Column header="IA" body="aiBody" />
          </DataTable>
        </Panel>
        <Panel header="Logs">
          <ScrollPanel style="height:120px">
            <div class="font-mono text-xs">
              <div v-for="log in logs" :key="log" class="log-line">{{ log }}</div>
            </div>
          </ScrollPanel>
          <div class="flex gap-2 mt-2">
            <Button label="Clear" icon="pi pi-trash" class="p-button-sm" @click="onClearLogs" />
            <Button label="Refresh" icon="pi pi-refresh" class="p-button-sm" @click="onRefreshLogs" />
          </div>
        </Panel>
      </div>
    </div>
    <Toast />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Menubar from 'primevue/menubar'
import Panel from 'primevue/panel'
import Card from 'primevue/card'
import Button from 'primevue/button'
import SplitButton from 'primevue/splitbutton'
import Slider from 'primevue/slider'
import Dropdown from 'primevue/dropdown'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import DataView from 'primevue/dataview'
import ScrollPanel from 'primevue/scrollpanel'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import Toast from 'primevue/toast'
import { switchSceneOnGabin, getCurrentSceneFromGabin } from '../gabinApi'

const route = useRoute()
const router = useRouter()

const toolbarItems = [
  { label: 'Home', icon: 'pi pi-home', command: () => router.push({ name: 'modality' }) },
  { label: 'Settings', icon: 'pi pi-cog' },
  { label: 'Logs', icon: 'pi pi-list' }
]
const isConnected = ref(true)
const isRecording = ref(false)
const activeScene = ref('Program')
const audioLevel = ref(63)
const tbarValue = ref(50)

// Modalités vidéo
const modalities = [
  { label: 'Podcast', value: 'podcast' },
  { label: 'Powerpoint sonorisé', value: 'powerpoint' },
  { label: 'Table ronde', value: 'tableronde' }
]
const participantsOptions = [
  { label: '1', value: 1 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 }
]
const selectedModality = ref(route.query.modality ? modalities.find(m => m.value === route.query.modality) : null)
const selectedParticipants = ref(route.query.participants ? participantsOptions.find(p => p.value == route.query.participants) : null)

function onModalityChange() {
  selectedParticipants.value = null
}
function onApplyModality() {
  // À brancher sur la logique métier (API Gabin, OBS, etc.)
}
function onResetModality() {
  selectedModality.value = null
  selectedParticipants.value = null
}

const cameras = [
  { name: 'Caméra 1' },
  { name: 'Caméra 2' },
  { name: 'Caméra 3' },
  { name: 'Program' }
]

const overlays = [
  { label: 'Logo', value: 'logo' },
  { label: 'Bandeau', value: 'bandeau' },
  { label: 'Timer', value: 'timer' }
]
const selectedOverlay = ref(null)
const activeOverlays = ref([])

const guests = ref([
  { name: 'Alice', video: '', muted: false, ai: false },
  { name: 'Bob', video: '', muted: true, ai: true }
])

const logs = ref([
  '10:00:01 [INFO] Démarrage OneClick Hub',
  '10:00:02 [INFO] Connexion Gabin OK',
  '10:00:03 [WARN] Audio level élevé',
  '10:00:04 [INFO] Prêt à enregistrer'
])

function onStartRec() { isRecording.value = true }
function onStopRec() { isRecording.value = false }
function onStartStream() { }
function onStopStream() { }
function onCut() { }
function onFade() { }

async function onSwitchScene(scene) {
  // Appelle Gabin pour changer la scène
  const result = await switchSceneOnGabin(scene)
  if (result.success) {
    activeScene.value = result.scene
    logs.value.push(`[Gabin] Scène changée : ${result.scene}`)
  } else {
    logs.value.push(`[Gabin] Erreur de changement de scène`)
  }
}

function onApplyOverlay() { if(selectedOverlay.value) activeOverlays.value.push(selectedOverlay.value) }
function onRemoveOverlay(overlay) { activeOverlays.value = activeOverlays.value.filter(o => o.value !== overlay.value) }
function onClearLogs() { logs.value = [] }
function onRefreshLogs() { logs.value.push('10:00:05 [INFO] Refresh logs') }

function videoBody(row) { return '🎥' }
function muteBody(row) { return row.muted ? 'pi pi-volume-off' : 'pi pi-volume-up' }
function aiBody(row) { return row.ai ? 'pi pi-user-check' : 'pi pi-user' }

onMounted(async () => {
  // Synchronise la scène active réelle depuis Gabin au démarrage
  activeScene.value = await getCurrentSceneFromGabin()
})
</script>

<style scoped>
.dashboard-bg {
  background: #0B213F;
}
.dashboard-menubar {
  border-radius: 0 0 10px 10px;
  background: #0B213F;
  color: #fff;
}
.dashboard-main {
  max-width: 1600px;
  margin: auto;
}
.modality-section {
  max-width: 1100px;
  margin: 0 auto 2rem auto;
}
.modality-card {
  border-radius: 14px;
  box-shadow: 0 2px 12px 0 rgba(99, 123, 170, 0.08);
  background: #12294b;
  color: #fff;
  border: 2px solid #f3c30033;
}
.modality-card:hover {
  box-shadow: 0 6px 32px 0 #f3c30066;
  border: 2.5px solid #f3c300;
}
.preview-badge {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: #1a3358;
  border-radius: 8px;
  padding: 0.5rem 1.2rem;
  margin-top: 0.5rem;
  font-size: 1.1rem;
  font-weight: 500;
  color: #fff;
  box-shadow: 0 1px 4px 0 rgba(60, 75, 102, 0.05);
}
.preview-type {
  font-weight: 600;
  color: #f3c300;
}
.preview-participants {
  font-weight: 400;
  color: #f3c300;
}
.log-line {
  white-space: pre;
  color: #fff;
}
.panel {
  background: #12294b;
  color: #fff;
}
</style>
