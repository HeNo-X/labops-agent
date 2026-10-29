<script setup lang="ts">
/**
 * 定时任务面板（兼容壳）
 * ============================================================================
 *  对外**保持原有 props / emits 完全不变**，内部换成重构后的 AutomationPanel。
 *
 *  为什么这么做：本组件是 PC 与移动端**唯一的**自动挂载点 ——
 *    · PC ：components/AgentSidebar.vue  → <ScheduledJobsPanel :navigation :icon-only />
 *    · 移动：mobile/MobileApp.vue        → <ScheduledJobsPanel :inline :job-id />
 *  保持壳不变，两端都自动拿到新形态，且不可能出现"改了一端忘了另一端"。
 */
import AutomationPanel from './automation/AutomationPanel.vue';
import type { Target } from '@shared/labops-targets.js';

defineProps<{
  readonly?: boolean;
  inline?: boolean;
  jobId?: string;
  navigation?: boolean;
  iconOnly?: boolean;
}>();

const emit = defineEmits<{ navigate: [Target] }>();
</script>

<template>
  <AutomationPanel
    :readonly="readonly"
    :inline="inline"
    :job-id="jobId"
    :navigation="navigation"
    :icon-only="iconOnly"
    @navigate="(target) => emit('navigate', target)"
  />
</template>
