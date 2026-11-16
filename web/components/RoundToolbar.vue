<script setup lang="ts">
import {t as tr} from "../i18n";
/**
 * 轮次操作条 —— 只显示「第 N 轮」标记：
 *  · 删除入口在助手回复底部的垃圾桶（见 ChatMessage round-delete）
 *  · 回档/修改在用户消息气泡下方的图标行（见 ChatMessage）
 */
defineProps<{ index: number }>();
</script>

<template>
  <div class="roundtool" :data-round="index">
    <span class="roundtool__idx">{{tr("第")}} {{ index }} {{tr("轮")}}</span>
  </div>
</template>

<style scoped>
.roundtool {
  display: flex;
  align-items: center;
  min-height: 18px;
}
.roundtool__idx {
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
  letter-spacing: 0.02em;
}
</style>
