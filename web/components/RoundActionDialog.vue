<script setup lang="ts">
/**
 * 轮次操作对话框（0.6.0）—— 回档 / 修改共用
 * ============================================================================
 *  两者原理相同：先把会话截断到本轮发起前，再决定要不要用新内容重新发起。
 *  所以共用一个弹窗、共用「同时回退本轮业务写入」这一选项，避免两处文案各自漂移。
 *
 *  文案纪律（照 Claude Code / Cursor 的公开限制写）：
 *    · 明确说清"会删掉本轮及其之后的对话"；
 *    · 明确说清业务写入能撤的撤、不能撤的会列清单 —— 不许暗示"全部可撤销"。
 */
import { nextTick, ref, watch } from 'vue';

const props = defineProps<{
  open: boolean;
  kind: 'rollback' | 'edit';
  roundIndex: number;
  /** 该轮原始提问（修改时作为初值） */
  question: string;
  busy: boolean;
  error: string;
  /** 后端已确认该轮确实牵涉业务写入，弹窗里提示会更具体 */
  hasBusinessWrites: boolean;
}>();
const emit = defineEmits<{ cancel: []; confirm: [{ text: string; revertEffects: boolean }] }>();

const text = ref('');
const revertEffects = ref(true);
const box = ref<HTMLTextAreaElement | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    text.value = props.question;
    revertEffects.value = true;
    await nextTick();
    box.value?.focus();
    box.value?.setSelectionRange(text.value.length, text.value.length);
  }
);

function confirm(): void {
  if (props.busy) return;
  if (props.kind === 'edit' && !text.value.trim()) return;
  emit('confirm', { text: text.value.trim(), revertEffects: revertEffects.value });
}
</script>

<template>
  <div v-if="open" class="dlg__mask" @click.self="!busy && emit('cancel')">
    <div class="dlg" role="dialog" aria-modal="true" :aria-label="kind === 'rollback' ? '回档到本轮发起前' : '修改本轮并重新发起'">
      <h2 class="dlg__h">
        {{ kind === 'rollback' ? `回档到第 ${roundIndex} 轮发起前` : `修改第 ${roundIndex} 轮并重新发起` }}
      </h2>

      <p class="dlg__p">
        {{
          kind === 'rollback'
            ? `第 ${roundIndex} 轮及其之后的全部对话会被移除，会话上下文回到这一轮发起之前的状态。`
            : `第 ${roundIndex} 轮及其之后的全部对话会被移除，然后用你修改后的内容重新发起这一轮。`
        }}
      </p>

      <label v-if="kind === 'edit'" class="dlg__field">
        <span class="dlg__label">修改后的提问</span>
        <textarea
          ref="box"
          v-model="text"
          class="dlg__text"
          rows="4"
          :disabled="busy"
          placeholder="修改这一轮要发送的内容…"
          @keydown.ctrl.enter.prevent="confirm"
          @keydown.meta.enter.prevent="confirm"
        ></textarea>
      </label>

      <label class="dlg__check">
        <input v-model="revertEffects" type="checkbox" :disabled="busy" />
        <span>同时回退本轮产生的业务写入</span>
      </label>
      <p class="dlg__note">
        沙盒内的写入（工单、通知、停用、值班）会真的撤回并留档；
        已提交到原系统的写入无法自动撤销，完成后会逐条列出，需人工在原系统处理。
        {{ hasBusinessWrites ? '本轮牵涉业务办理，服务端会逐条核对并如实报告。' : '' }}
      </p>

      <p v-if="error" class="dlg__err" role="alert">{{ error }}</p>

      <div class="dlg__foot">
        <button type="button" class="dlg__btn" :disabled="busy" @click="emit('cancel')">取消</button>
        <button
          type="button"
          class="dlg__btn dlg__btn--danger"
          :disabled="busy || (kind === 'edit' && !text.trim())"
          @click="confirm"
        >
          {{ busy ? '处理中…' : kind === 'rollback' ? '确认回档' : '确认修改并重发' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dlg__mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-3);
  z-index: 40;
}
.dlg {
  width: min(520px, 100%);
  max-height: 86vh;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  text-align: left;
}
.dlg__h {
  margin: 0;
  font-size: 15px;
}
.dlg__p {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.6;
}
.dlg__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dlg__label {
  font-size: 12px;
  color: var(--text-faint);
}
.dlg__text {
  width: 100%;
  resize: vertical;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
}
.dlg__check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text);
}
.dlg__note {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
}
.dlg__err {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
.dlg__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
}
.dlg__btn {
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text);
  font-size: 13px;
  border-radius: var(--radius-sm);
  padding: 5px 16px;
  cursor: pointer;
}
.dlg__btn:hover:not(:disabled) {
  background: var(--surface-3);
}
.dlg__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dlg__btn--danger {
  border-color: var(--danger);
  background: var(--danger);
  color: #fff;
}
.dlg__btn--danger:hover:not(:disabled) {
  filter: brightness(1.06);
  background: var(--danger);
}
</style>
