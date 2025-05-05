import { createRouter, createWebHashHistory } from 'vue-router';
import ModalitySelectView from '../views/ModalitySelectView.vue';
import DashboardView from '../views/DashboardView.vue';
import TvView from '../views/TvView.vue';
import ParticipantSelectView from '../views/ParticipantSelectView.vue';
import ParticipantPositionView from '../views/ParticipantPositionView.vue';
import CameraSetupView from '../views/CameraSetupView.vue';
import MicrophoneSetupView from '../views/MicrophoneSetupView.vue';
import LiveControlView from '../views/LiveControlView.vue';

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'modality', component: ModalitySelectView },
    { path: '/dashboard', name: 'dashboard', component: DashboardView },
    { path: '/tv', component: TvView },
    { path: '/participants', name: 'ParticipantSelect', component: ParticipantSelectView },
    { path: '/participant-position', name: 'ParticipantPosition', component: ParticipantPositionView },
    { path: '/camera-setup', name: 'CameraSetup', component: CameraSetupView },
    { path: '/microphone-setup', name: 'MicrophoneSetup', component: MicrophoneSetupView },
    { path: '/live-control', name: 'LiveControl', component: LiveControlView },
    { path: '/podcast', name: 'Podcast', component: () => import('../views/PodcastView.vue') }
  ]
});
