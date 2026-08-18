import { createApp } from 'vue';
import TranslationApp from './TranslationApp.vue';
import { initServerAuth } from './api/daemon/serverAuth';
import i18n from './i18n';
import { installClientErrorCapture } from './debug/trace';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/inter/opsz-italic.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './style.css';

// Always retain bounded metadata for uncaught failures. With ?debug=1 / the
// debug flag, console output is included too; HMR restores listeners/wrappers.
installClientErrorCapture();

// Consume the one-time `#token=` handoff before any component creates the
// daemon client and issues its first authenticated request. Bootstrap is the
// single owner of this ordering contract, independent of the mounted shell.
initServerAuth();

createApp(TranslationApp).use(i18n).mount('#app');
