<script setup lang="ts">
/**
 * 确认弹层宿主（批次 A）—— Promise 化替代 window.confirm。
 * 底部 sheet + grabber（mobile.css）；destructive=true 主按钮红色。
 * 批次 D 将在此基础上扩展为完整办理单确认弹层。
 */
import { t as tr } from '../i18n';
import { useFeedback } from '../mobile/feedback';
import { useDragClose } from '../mobile/gestures';

const { state, answerConfirm } = useFeedback();
// 批次 C：grabber 区下拉关闭（等价于取消）
const drag = useDragClose(() => answerConfirm(false));
</script>

<template>
  <Teleport to="body">
    <div v-if="state.confirm.open" class="mobile-sheet-mask" @click.self="answerConfirm(false)">
      <section class="mobile-sheet" role="dialog" aria-modal="true" :aria-label="state.confirm.title" v-on="drag.handlers" :style="drag.style.value">
        <h2>{{ state.confirm.title }}</h2>
        <p v-if="state.confirm.message">{{ state.confirm.message }}</p>
        <div class="mobile-actions" style="margin-top:12px">
          <button type="button" @click="answerConfirm(false)">{{ tr(state.confirm.cancelLabel || '取消') }}</button>
          <button
            type="button"
            class="mobile-primary"
            :style="state.confirm.destructive ? 'background:var(--danger);border-color:var(--danger)' : ''"
            @click="answerConfirm(true)"
          >
            {{ tr(state.confirm.confirmLabel || '确认') }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
