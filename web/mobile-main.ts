import {createApp} from 'vue';import {createPinia} from 'pinia';import MobileApp from './mobile/MobileApp.vue';import {bootstrapAuth,routeEdition} from './auth/bootstrap';import {registerOfflineShell} from './offline-shell';import './styles/tokens.css';import './mobile/tokens.css';import './mobile/mobile.css';
await bootstrapAuth();if(!routeEdition())createApp(MobileApp).use(createPinia()).mount('#app');
registerOfflineShell();

import './styles/preferences.css';
