<script setup lang="ts">
import {t as tr} from "../i18n";
/**
 * 人工确认卡 —— 只在**真实待确认写操作**存在时渲染（阶段 2B 接入）
 * ============================================================================
 *  第一阶段服务端没有注册任何写操作工具，store.pendingConfirm 恒为 null，
 *  因此本组件**不会被渲染** —— 不再有常驻的占位示意卡吸走注意力，
 *  也不再出现"看起来坏了"的禁用按钮。
 *
 *  将来（publish_notification / create_inspection_ticket）接入时：
 *   · 服务端发出 need_confirm 事件 → store.pendingConfirm 出现结构化草稿
 *   · 本组件渲染草稿全文、影响范围与 确认/修改/取消 三个真实动作
 *   · 模型只产出草稿，服务端在确认后重验 + 幂等键执行
 *  在那之前，这里保持空实现是唯一诚实的做法。
 */
defineProps<{ /* 阶段 2B：这里将接收结构化的待确认动作草稿 */ }>();
</script>

<template>
  <section class="confirm" role="alertdialog" :aria-label="tr('人工确认')">
    <p class="confirm__wait">{{tr("待确认操作已到达，等待人工确认。（本区块将在阶段 2B 接入写操作时启用）")}}</p>
  </section>
</template>

<style scoped>
.confirm {
  border: 1px solid var(--warn-border);
  background: var(--warn-bg);
  border-radius: var(--radius);
  padding: var(--sp-3);
}
.confirm__wait {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--warn);
}
</style>
