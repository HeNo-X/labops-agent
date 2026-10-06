<script setup lang="ts">
/**
 * 数据来源徽章 —— 界面上任何一处展示数据，都必须能一眼看到它是实时/快照/演示。
 * 三者的视觉编码都不同（符号 + 文案 + 边框），不靠颜色区分。
 */
import { computed } from 'vue';
import type { DataSourceType, EngineType } from '@shared/types';
import { DATA_SOURCE_LABELS } from '@shared/types';
import StatusTag from './StatusTag.vue';
import type { Tone } from './ui-types';

const props = defineProps<{
  sourceType: DataSourceType | null;
  /** 可选的引擎标识：演示引擎必须与数据来源分开显示，避免混为一谈 */
  engine?: EngineType | null;
  /** 实际使用的模型 id（可选）。有值时直接显示，用户不必去翻配置才知道"谁在回答" */
  model?: string | null;
  compact?: boolean;
}>();

const TONE: Record<DataSourceType, Tone> = {
  live: 'ok', // 实时
  snapshot: 'info', // 脱敏快照
  demo: 'warn' // 模拟演示
};

const GLYPH: Record<DataSourceType, string> = {
  live: '⚡',
  snapshot: '▣',
  demo: '◇'
};

const CAVEAT: Record<DataSourceType, string> = {
  live: '当前业务数据：取证时间与授权范围见查询结果',
  snapshot: '脱敏快照：从真实数据导出后已脱敏，非实时',
  demo: '模拟演示：内置构造的示例数据，与真实实验室无关'
};

const label = computed(() => (props.sourceType ? DATA_SOURCE_LABELS[props.sourceType] : '来源未知'));
const tone = computed<Tone>(() => (props.sourceType ? TONE[props.sourceType] : 'neutral'));
const glyph = computed(() => (props.sourceType ? GLYPH[props.sourceType] : '?'));
const caveat = computed(() =>
  props.sourceType ? CAVEAT[props.sourceType] : '尚未取得数据来源信息'
);

/**
 * 引擎标注（2026-10-06 修正）
 * 旧实现只认 agnes，其它一律说成"确定性事实 / 演示（规则）"——
 * 聊天模式走 DashScope 链时会被**错标成规则引擎**，用户会以为聊天没在用大模型。
 * 现在按 engine 分模式如实标注；能拿到具体模型 id 时直接写出来。
 */
const CHAT_ENGINE = 'dashscope' as const;
const engineIsLlm = computed(() => props.engine === 'agnes' || props.engine === CHAT_ENGINE);
const engineBadge = computed(() => {
  const m = props.model;
  if (props.engine === CHAT_ENGINE) return m ? `引擎：DashScope · ${m}` : '引擎：DashScope（聊天链）';
  if (props.engine === 'agnes') return m ? `引擎：Agnes · ${m}` : '引擎：Agnes';
  if (props.engine === 'facts') return '引擎：可靠事实转换';
  return props.sourceType === 'live' ? '引擎：确定性事实' : '引擎：演示（规则）';
});
const engineCaveat = computed(() => {
  if (props.engine === CHAT_ENGINE) return `聊天模式固定走 DashScope（阿里云百炼）多模型链${props.model ? `，本轮模型 ${props.model}` : ''}；工作模式走 Agnes`;
  if (props.engine === 'agnes') return `工作（任务）模式固定走 Agnes${props.model ? `，本轮模型 ${props.model}` : ''}`;
  if (props.engine === 'facts') return '由服务端已核验事实做确定性转换，未调用大模型';
  return '当前模式未配置大模型：由服务端规则引擎解析并渲染回答，未调用大模型';
});
</script>

<template>
  <span class="src">
    <StatusTag :tone="tone" :label="`数据：${label}`" :glyph="glyph" :title="caveat" />
    <StatusTag
      v-if="engine !== null && engine !== undefined"
      :tone="engineIsLlm ? 'ok' : 'warn'"
      :glyph="engineIsLlm ? '★' : '⚙'"
      :label="engineBadge"
      :title="engineCaveat"
    />
    <span v-if="!compact" class="src__note">（{{ caveat }}）</span>
  </span>
</template>

<style scoped>
.src {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.src__note {
  color: var(--text-faint);
  font-size: 12px;
}
</style>
