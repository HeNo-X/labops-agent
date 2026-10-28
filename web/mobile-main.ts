import {createApp} from 'vue';import {createPinia} from 'pinia';import MobileApp from './mobile/MobileApp.vue';import {bootstrapAuth,routeEdition} from './auth/bootstrap';import './styles/tokens.css';import './mobile/tokens.css';import './mobile/mobile.css';
await bootstrapAuth();if(!routeEdition())createApp(MobileApp).use(createPinia()).mount('#app');

import './styles/preferences.css';
