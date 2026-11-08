<script setup lang="ts">
import {computed} from 'vue';import {useModal} from '../composables/useModal';import SettingsPanel from './SettingsPanel.vue';import {t as tr} from '../i18n';
const props=withDefaults(defineProps<{open:boolean;taskMode?:boolean}>(),{taskMode:true}),emit=defineEmits<{close:[];edition:[];logout:[]}>();
const visible=computed({get:()=>props.open,set:value=>{if(!value)emit('close');}});useModal(visible,'.settings-dialog');
function launch(action:string){emit('close');window.dispatchEvent(new CustomEvent('labops-target',{detail:{action}}));}
</script>
<template><Teleport to="body"><div v-if="open" class="settings-mask"><section class="settings-dialog" role="dialog" aria-modal="true" :aria-label="tr('设置')"><SettingsPanel :show-back="true" :task-mode="taskMode" @back="emit('close')" @edition="emit('edition')" @logout="emit('logout')" @launch="launch"/></section></div></Teleport></template>
<style scoped>.settings-mask{position:fixed;inset:0;background:var(--surface);z-index:120}.settings-dialog{background:var(--surface);color:var(--text);width:100%;height:100dvh;overflow:hidden}</style>