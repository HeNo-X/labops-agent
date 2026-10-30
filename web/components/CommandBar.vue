<script setup lang="ts">
import {t as tr} from "../i18n";
/**
 * 命令栏 —— 任务的唯一输入入口，两种形态同一组件
 * ============================================================================
 *  · variant="hero"：空态居中的大输入框（主区主角）
 *  · variant="dock"：任务开始后吸底的紧凑输入栏
 *  · 中文自然语言输入，Enter 提交（Shift+Enter 换行）
 *  · 示例问题来自真实数据（房间号取自 /api/state，演示日期由 termStart 推导），
 *    **点击即发起任务**，不再只填充
 *  · 运行中**不再锁死输入框**：仍不允许并发提交（提交锁不变），但允许"补一句" ——
 *    运行中输入的那句进入待发送（单条、按会话隔离），本轮结束后由父组件决定
 *    自动发出还是填回草稿。示例 chips 在运行中仍禁用。
 */
import { computed } from 'vue';
import { useRunStore } from '../stores/run';
import { useVoiceInput } from '../composables/useVoiceInput';
import StatusTag from './StatusTag.vue';
import UiIcon from './UiIcon.vue';

// ⚠️ Boolean prop 必须显式给默认值：Vue 对未传入的 Boolean 类型 prop 会直接置为
// false（而不是 undefined），不写 withDefaults 会让 `examples?: boolean` 的
// "不传=显示" 语义失效（实测踩坑：任务模式示例因此消失）。
const props = withDefaults(
  defineProps<{
    variant?: 'hero' | 'dock';
    submitting?: boolean;
    /** 是否显示示例问题（聊天模式下任务型示例会造成误导，由父组件关闭） */
    examples?: boolean;
    /** 输入框占位文案（聊天/任务模式文案不同） */
    placeholder?: string;
    /** 提交按钮文案 */
    submitLabel?: string;
    /** 待发送文本（仅当属于当前会话时由父组件传入；null 表示没有） */
    pendingText?: string | null;
    /** 最近一次排入覆盖了上一条待发送 */
    pendingReplaced?: boolean;
    /** 一次性提示（如"已填回输入框，请确认后发送"） */
    notice?: string | null;
  }>(),
  {
    variant: 'hero',
    submitting: false,
    examples: true,
    placeholder: undefined,
    submitLabel: undefined,
    pendingText: null,
    pendingReplaced: false,
    notice: null
  }
);
const store = useRunStore();
/** 草稿由父组件 v-model 持有：房间点击可回填、失败可恢复、切会话可分别保存（F27/F29） */
const text = defineModel<string>('draft', { default: '' });

const isHero = computed(() => props.variant !== 'dock');
/** 输入锁定只看运行生命周期；工具结果到达不解锁（P0 修复） */
// R16：提交状态（创建会话/等待接受）也要锁输入并可见，避免"点了没反应"或重复提交
const canSubmit = computed(() => text.value.trim().length > 0 && !store.inputLocked && !props.submitting);
const busy = computed(() => store.inputLocked || Boolean(props.submitting));
/**
 * 等待你拍板 ≠ 机器在算（T1 相位机）：need_confirm 到达后 runStatus 仍是 running
 * （输入互斥不放宽），但状态标签换成"等待你的确认"、glyph 换 ⏸（StatusTag 本就无动画，
 * 不新增 CSS 动效），工作计时由 store 暂停累计。
 */
const awaitingConfirm = computed(() => store.phase === 'awaiting_confirm');

const emit = defineEmits<{ submit: [string]; queue: [string]; cancel: []; 'cancel-pending': [] }>();

function submit(): void {
  if (!text.value.trim()) return;
  const q = text.value.trim();
  // 运行中：进入待发送（不并发提交，也不丢用户的输入）
  if (busy.value) {
    emit('queue', q);
    text.value = '';
    return;
  }
  if (!canSubmit.value) return;
  emit('submit', q);
  // F27：发出即清空草稿（父组件已在会话内保存该轮消息）
  text.value = '';
}

/** 示例问题：点击即发起（一句话交办，少一次无意义点击） */
function useExample(q: string): void {
  if (busy.value) return;
  emit('submit', q);
}

// ---- 语音输入：与移动端 MobileConversation 同一 composable、同一套错误码文案 ----
const voice = useVoiceInput();
const voiceHint = computed(() => {
  const code = voice.errorCode.value;
  if (!code || code === 'aborted') return '';
  const messages: Partial<Record<string, string>> = {
    unsupported: tr('当前浏览器不支持录音'),
    insecure: tr('语音输入需要 HTTPS 或 localhost 环境'),
    denied: tr('麦克风权限被拒绝，请在浏览器地址栏允许后重试'),
    no_device: tr('未检测到可用麦克风'),
    busy: tr('已有录音在进行'),
    network: tr('网络异常，转写失败'),
    not_configured: tr('语音识别未配置：请在服务端 .env 设置 ASR_API_KEY'),
    rate_limited: tr('语音转写已达每小时配额，请稍后再试'),
    upstream: tr('识别服务暂不可用，请稍后重试'),
    empty: tr('没有听清，请靠近一点再说一次'),
    unknown: tr('语音识别失败，请重试')
  };
  return messages[code] || '';
});

async function onVoice(): Promise<void> {
  const state = voice.status.value;
  if (state === 'idle') {
    await voice.start();
    return;
  }
  if (state === 'recording') {
    const recognized = await voice.stop();
    // 识别结果并入草稿而非覆盖：用户可能已经打了一半
    if (recognized) text.value = text.value ? `${text.value.replace(/\s+$/, '')} ${recognized}` : recognized;
  }
}
function onVoiceCancel(): void {
  voice.cancel();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
}
// F27：不再在任务结束时抢焦点 —— 用户可能正在读历史或操作其他控件
</script>

<template>
  <section class="bar" :class="isHero ? 'bar--hero' : 'bar--dock'" aria-labelledby="bar-h">
    <h2 id="bar-h" class="sr-only">{{tr("命令栏")}}</h2>

    <div v-if="isHero && props.examples !== false" class="bar__examples">
      <button
        v-for="q in store.exampleQuestions"
        :key="q"
        type="button"
        class="chip"
        :disabled="busy"
        @click="useExample(q)"
      >
        {{ q }}
      </button>
    </div>

    <div
      v-if="voice.working.value"
      class="bar__voice"
      role="status"
      aria-live="polite"
    >
      <span class="bar__voice-dot" aria-hidden="true"></span>
      <b>{{ tr(voice.status.value === 'transcribing' ? '识别中…' : voice.status.value === 'requesting' ? '等待麦克风…' : '正在聆听') }}</b>
      <span class="bar__voice-time">{{ Math.floor(voice.seconds.value) }}s / 60s</span>
      <button type="button" class="bar__voice-cancel" @click="onVoiceCancel">{{ tr('取消') }}</button>
    </div>

    <div class="bar__row">
      <label class="sr-only" for="cmd">{{tr("输入你的实验室问题")}}</label>
      <!--
        录音期间按钮**不能隐藏**：onVoice() 的 recording 分支负责"停止并转写"，
        若此处用 !voice.working 把它藏掉，该分支就成了死代码 —— 用户只能取消，
        录完的话拿不回来（浏览器实测复现）。改由 working 时高亮表达状态。
      -->
      <button
        v-if="voice.supported.value"
        type="button"
        class="bar__mic"
        :class="{ 'is-active': voice.working.value }"
        :disabled="busy"
        :aria-label="tr(voice.status.value === 'recording' ? '停止录音并识别' : '语音输入')"
        :title="tr(voice.status.value === 'recording' ? '停止录音并识别' : '语音输入')"
        @click="onVoice"
      >
        <UiIcon name="mic" />
      </button>
      <textarea
        id="cmd"
        ref="inputEl"
        v-model="text"
        class="bar__input"
        :rows="isHero ? 2 : 1"
        :placeholder="busy ? tr('本轮还在执行，可先写下要补的一句（本轮结束后发送）') : props.placeholder ?? '输入实验室问题或要办理的事项…'"
        :disabled="voice.working.value"
        @keydown="onKeydown"
      />
      <button v-if="!busy" type="button" class="bar__btn" :disabled="!canSubmit" @click="submit">
        {{tr(props.submitLabel ?? '发送')}}
      </button>
      <template v-else>
        <button type="button" class="bar__btn bar__btn--queue" :disabled="!text.trim()" @click="submit">
          {{tr('加入待发送')}}
        </button>
        <button type="button" class="bar__btn bar__btn--ghost" @click="emit('cancel')">{{tr("停止")}}</button>
      </template>
    </div>

    <!-- 待发送：细线提示行 + 可取消。只表达"暂存意图"，不代表已经发出 -->
    <div v-if="props.pendingText" class="bar__pending" role="status">
      <span class="bar__pending-line"></span>
      <span class="bar__pending-text">
        {{tr('将在本轮结束后发送：')}}<b>{{ props.pendingText.slice(0, 40) }}{{ props.pendingText.length > 40 ? '…' : '' }}</b>
        <em v-if="props.pendingReplaced">{{tr('（已替换上一条待发送）')}}</em>
      </span>
      <button type="button" class="bar__pending-cancel" @click="emit('cancel-pending')">{{tr("取消")}}</button>
    </div>

    <p v-if="props.notice" class="bar__notice" role="status">{{ tr(props.notice) }}</p>

    <p v-if="voiceHint" class="bar__voice-hint" role="alert">{{ voiceHint }}</p>

    <div v-if="busy" class="bar__hint">
      <StatusTag
        v-if="busy"
        :tone="awaitingConfirm ? 'warn' : 'info'"
        :glyph="awaitingConfirm ? '⏸' : '◌'"
        :label="awaitingConfirm ? tr('等待你的确认') : props.submitting && !store.inputLocked ? tr('正在提交…') : tr('任务执行中')"
        :title="awaitingConfirm ? tr('已生成待确认办理单，请在对话中确认或取消') : tr('正在处理，请稍候')"
      />
    </div>

    <div v-if="!isHero && props.examples !== false" class="bar__examples bar__examples--dock">
      <span class="bar__examples-label">{{tr("示例：")}}</span>
      <button v-for="q in store.exampleQuestions" :key="q" type="button" class="chip" :disabled="busy" @click="useExample(q)">
        {{ q }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.bar {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--sp-3) var(--sp-4);
  box-shadow: var(--shadow-2);
}
.bar--hero {
  max-width: 680px;
  margin: 0 auto;
  padding: var(--sp-4) var(--sp-5);
}
.bar--hero .bar__input {
  font-size: calc(var(--ui-font-size) * 1.15385);
  min-height: 56px;
}
.bar--hero .bar__btn {
  min-height: 56px;
  font-size: calc(var(--ui-font-size) * 1.15385);
}
/* 语音输入：细线 + 轻投影，不用渐变/发光（与全站一致的克制风格） */
.bar__mic {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 40px;
  min-height: 40px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--text-muted);
  cursor: pointer;
}
.bar__mic:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-strong);
}
.bar__mic:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 录音中：用边框与前景色变化表达，不加发光（全站禁用辉光风格） */
.bar__mic.is-active {
  color: var(--warn);
  border-color: var(--warn-border);
  background: var(--warn-bg);
}
.bar__voice {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  font-size: calc(var(--ui-font-size) * 0.92308);
}
.bar__voice-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warn);
  flex: 0 0 auto;
}
.bar__voice-time {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.bar__voice-cancel {
  margin-left: auto;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.88462);
  cursor: pointer;
}
.bar__voice-hint {
  margin: var(--sp-2) 0 0;
  color: var(--danger);
  font-size: calc(var(--ui-font-size) * 0.88462);
}
@media (prefers-reduced-motion: no-preference) {
  .bar__voice-dot {
    animation: bar-voice-pulse 1.2s ease-in-out infinite;
  }
  @keyframes bar-voice-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
}
.bar__examples {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.bar__examples--dock {
  justify-content: flex-start;
  margin-top: var(--sp-2);
  margin-bottom: 0;
}
.bar__examples-label {
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-faint);
}
.chip {
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.92308);
  padding: 3px 12px;
  cursor: pointer;
}
.chip:hover:not(:disabled) {
  color: var(--primary);
  border-color: var(--primary-border);
  background: var(--primary-weak);
}
.chip:disabled {
  opacity: 0.5;
  cursor: default;
}
.bar__row {
  display: flex;
  gap: var(--sp-2);
  align-items: stretch;
}
.bar__input {
  flex: 1;
  min-width: 0;
  resize: vertical;
  min-height: 40px;
  max-height: 140px;
  padding: 9px var(--sp-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
}
.bar__input:disabled {
  opacity: 0.6;
}
.bar__btn {
  position: static;
  z-index: auto;
  transform: none;
  flex: 0 0 auto;
  padding: 0 var(--sp-5);
  border: 1px solid var(--primary);
  border-radius: var(--radius);
  background: var(--primary);
  color: var(--primary-contrast);
  font-size: calc(var(--ui-font-size) * 1.07692);
  font-weight: 600;
  cursor: pointer;
  min-height: 40px;
}
.bar__btn:hover:not(:disabled) {
  background: var(--primary-hover);
}
.bar__btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.bar__btn--ghost {
  background: transparent;
  color: var(--text-muted);
  border-color: var(--border-strong);
}
.bar__btn--ghost:hover {
  background: var(--surface-3);
  color: var(--text);
}
/* 待发送按钮：次于主操作的视觉权重（细线描边，不抢"停止"与正文） */
.bar__btn--queue {
  background: var(--surface-2);
  color: var(--text);
  border-color: var(--border-strong);
}
.bar__btn--queue:hover:not(:disabled) {
  background: var(--surface-3);
}
/* 待发送提示行：一条细线 + 摘要，右侧取消 */
.bar__pending {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: var(--sp-2) 0 0;
  font-size: calc(var(--ui-font-size) * 0.88462);
  color: var(--text-muted);
}
.bar__pending-line {
  flex: 0 0 auto;
  width: 14px;
  height: 1px;
  background: var(--border-strong);
}
.bar__pending-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar__pending-text b {
  color: var(--text);
  font-weight: 500;
}
.bar__pending-text em {
  color: var(--text-faint);
  font-style: normal;
}
.bar__pending-cancel {
  margin-left: auto;
  flex: 0 0 auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.84615);
  padding: 1px 8px;
  cursor: pointer;
}
.bar__pending-cancel:hover {
  color: var(--text);
  background: var(--surface-2);
}
.bar__notice {
  margin: var(--sp-2) 0 0;
  font-size: calc(var(--ui-font-size) * 0.88462);
  color: var(--warn);
}
.bar__hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  margin: var(--sp-2) 0 0;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-faint);
  flex-wrap: wrap;
}
.bar__hint-text b {
  color: var(--text-muted);
  font-family: var(--font-mono);
}

@media (max-width: 640px) {
  .bar {
    padding: var(--sp-2) var(--sp-3);
  }
  .bar--hero {
    padding: var(--sp-3);
  }
  /* 示例问题改成单行横向滚动 —— 换行会把吸底栏撑到 250px+，挡住正文 */
  .bar__examples {
    flex-wrap: nowrap;
    justify-content: flex-start;
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: none;
  }
  .bar__examples::-webkit-scrollbar {
    display: none;
  }
  .chip {
    flex: 0 0 auto;
  }
  .bar__row {
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .bar__input {
    flex: 1 1 100%;
    min-height: 38px;
    padding: 7px var(--sp-3);
  }
  .bar__btn {
    flex: 1 1 100%;
    min-height: 38px;
  }
  /* 提示长句在手机上不显示：吸底栏的每一像素都要留给输入本身 */
  .bar__hint-text {
    display: none;
  }
  .bar__hint {
    margin-top: var(--sp-1);
  }
}
</style>
