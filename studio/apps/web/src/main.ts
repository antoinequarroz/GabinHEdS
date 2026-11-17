import { createApp } from 'vue';
import App from './App.vue';
import { applyStoredTheme } from './composables/useTheme';
import './styles.css';
import './guests/guests.css';

applyStoredTheme();
createApp(App).mount('#app');
