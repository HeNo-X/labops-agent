import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles/tokens.css';

import {bootstrapAuth,routeEdition} from './auth/bootstrap';
import {registerOfflineShell} from './offline-shell';
await bootstrapAuth();
const app = createApp(App);
app.use(createPinia());
if(!routeEdition())app.mount('#app');
registerOfflineShell();

import './styles/preferences.css';
