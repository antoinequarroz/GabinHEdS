import { createApp } from 'vue';
import App from './App.vue';
import { applyStoredTheme } from './composables/useTheme';
import './styles.css';
import './guests/guests.css';
import './suite/base.css';
import './suite/shell.css';
import './suite/library.css';
import './suite/production.css';
import './suite/regie.css';
import './suite/settings.css';
import './suite/guests.css';

applyStoredTheme();
createApp(App).mount('#app');
