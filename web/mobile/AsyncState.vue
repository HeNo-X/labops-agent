<script setup lang="ts">
import {t as tr} from "../i18n";
defineProps<{loading?:boolean;error?:string;empty?:boolean;emptyText?:string}>();defineEmits<{retry:[]}>();
</script>
<template><p v-if="loading" class="mobile-state" role="status">{{tr("正在读取当前账号的数据…")}}</p><div v-else-if="error" class="mobile-state error" role="alert"><p>{{error}}</p><button @click="$emit('retry')">{{tr("重新读取")}}</button></div><p v-else-if="empty" class="mobile-state">{{tr(emptyText||'当前没有记录。')}}</p><slot v-else/></template>
