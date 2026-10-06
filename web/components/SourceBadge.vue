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
</script>

<template>
  <span class="src">
    <StatusTag :tone="tone" :label="`数据：${label}`" :glyph="glyph" :title="caveat" />
    <StatusTag
      v-if="engine !== null && engine !== undefined"
      :tone="engine === 'agnes' ? 'ok' : 'warn'"
      :glyph="engine === 'agnes' ? '★' : '⚙'"
      :label="engine === 'agnes' ? '引擎：Agnes 3.0 Flash' : sourceType==='live' ? '引擎：确定性事实' : '引擎：演示（规则）'"
      :title="
        engine === 'agnes'
          ? '由 Agnes 3.0 Flash 做工具选择与回答生成'
          : '未配置 AGNES_API_KEY：由服务端规则引擎解析并渲染回答，未调用大模型'
      "
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
