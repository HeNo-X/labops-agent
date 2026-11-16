<script setup lang="ts">
/**
 * 加载/错误/空态容器：
 *  · loading → 骨架屏（shimmer，reduced-motion 下静态）
 *  · empty   → 结构化空态（圆形图标位 + 文案 + 可选行动钮插槽）
 *  · error   → 保持原文案 + 重试按钮
 */
import {t as tr} from "../i18n";
defineProps<{loading?:boolean;error?:string;empty?:boolean;emptyText?:string}>();defineEmits<{retry:[]}>();
</script>
<template><div v-if="loading" class="m-skel m-skel--card" role="status" :aria-label="tr('正在读取当前账号的数据…')"><div class="m-skel m-skel--title"></div><div class="m-skel m-skel--line" style="width:86%"></div><div class="m-skel m-skel--line" style="width:62%"></div></div><div v-else-if="error" class="mobile-state error" role="alert"><p>{{error}}</p><button @click="$emit('retry')">{{tr("重新读取")}}</button></div><div v-else-if="empty" class="m-empty"><p>{{tr(emptyText||'当前没有记录。')}}</p><slot name="empty-action"/></div><slot v-else/></template>
