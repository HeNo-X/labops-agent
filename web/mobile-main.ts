import {createApp} from 'vue';import {createPinia} from 'pinia';import MobileApp from './mobile/MobileApp.vue';import {bootstrapAuth,routeEdition} from './auth/bootstrap';import './styles/tokens.css';import './mobile/mobile.css';
await bootstrapAuth();if(!routeEdition())createApp(MobileApp).use(createPinia()).mount('#app');

const themeMedia=matchMedia('(prefers-color-scheme: dark)');themeMedia.addEventListener('change',()=>{const theme=localStorage.getItem('labops.theme');if(!theme||theme==='auto')document.documentElement.dataset.theme=themeMedia.matches?'dark':'light';});
