<script setup lang="ts">
import {t as tr} from "../i18n";
/**
 * 命令栏 —— 任务的唯一输入入口，两种形态同一组件
 * ============================================================================
 *  · variant="hero"：空态居中的大输入框（主区主角）
 *  · variant="dock"：任务开始后吸底的紧凑输入栏
 *  · 中文自然语言输入，Enter 提交（Shift+Enter 换行）
 *  · 示例问题来自真实数据（房间号取自 /api/state，日期由 termStart 推导），
 *    **点击即发起任务**
 *  · 运行中不锁死输入框：仍不允许并发提交（提交锁不变），但允许"补一句" ——
 *    运行中输入的那句进入待发送（单条、按会话隔离），本轮结束后由父组件决定
 *    自动发出还是填回草稿。示例 chips 在运行中仍禁用。
 */
import { computed } from 'vue';
import { useRunStore } from '../stores/run';
import StatusTag from './StatusTag.vue';
import ComposerBar from './ComposerBar.vue';

// ⚠️ Boolean prop 必须显式给默认值：Vue 对未传入的 Boolean 类型 prop 会直接置为
// false（而不是 undefined），不写 withDefaults 会让 `examples?: boolean` 的
// "不传=显示" 语义失效。
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
    /** 当前会话待执行队列（最多 3 条，按序自动执行） */
    queued?: string[];
    /** 风险任务进行中（已生成待确认办理单）→ 禁止"立即发送"打断 */
    riskyRunning?: boolean;
  }>(),
  {
    variant: 'hero',
    submitting: false,
    examples: true,
    placeholder: undefined,
    submitLabel: undefined,
    pendingText: null,
    pendingReplaced: false,
    notice: null,
    queued: () => [],
    riskyRunning: false
  }
);
const store = useRunStore();
/** 草稿由父组件 v-model 持有：房间点击可回填、失败可恢复、切会话可分别保存 */
const text = defineModel<string>('draft', { default: '' });

const isHero = computed(() => props.variant !== 'dock');
/** 输入锁定只看运行生命周期；工具结果到达不解锁 */
// 提交状态（创建会话/等待接受）也要锁输入并可见，避免"点了没反应"或重复提交
const canSubmit = computed(() => text.value.trim().length > 0 && !store.inputLocked && !props.submitting);
const busy = computed(() => store.inputLocked || Boolean(props.submitting));
/**
 * 等待你确认 ≠ 机器在算：need_confirm 到达后 runStatus 仍是 running
 * （输入互斥不放宽），但状态标签显示为"等待你的确认"、glyph 用 ⏸（StatusTag 本就无动画，
 * 不另加 CSS 动效），工作计时由 store 暂停累计。
 */
const awaitingConfirm = computed(() => store.phase === 'awaiting_confirm');

const emit = defineEmits<{ submit: [string]; queue: [string]; cancel: []; 'cancel-pending': []; 'immediate-send': [string]; 'drop-queued': [string] }>();

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
  // 发出即清空草稿（父组件已在会话内保存该轮消息）
  text.value = '';
}

/** 示例问题：点击即发起（一句话交办，少一次无意义点击） */
function useExample(q: string): void {
  if (busy.value) return;
  // 示例只帮你想问题：填进输入框待确认，不替他直接发出去
  text.value = q;
}

// ---- 语音输入：与移动端 MobileConversation 同一 composable、同一套错误码文案 ----
// 任务结束时不抢焦点 —— 用户可能正在读历史或操作其他控件
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

    <ComposerBar
      v-model:draft="text"
      :variant="isHero ? 'hero' : 'dock'"
      input-id="cmd"
      :busy="busy"
      :rows="isHero ? 2 : 1"
      :placeholder="props.placeholder ?? '输入实验室问题或要办理的事项…'"
      :submit-label="props.submitLabel ?? '发送'"
      @submit="submit"
      @stop="emit('cancel')"
      @queue="(q) => emit('queue', q)"
    />

    <!-- 待执行队列：最多 3 条，本轮结束后按序自动执行；可单条立即发送或删除 -->
    <div v-if="props.queued.length" class="bar__queue" role="status">
      <div class="bar__queue-head">
        <span class="bar__queue-title">{{tr('待执行')}} · {{ props.queued.length }}/3</span>
        <button type="button" class="bar__queue-clear" @click="emit('cancel-pending')">{{tr('全部清空')}}</button>
      </div>
      <ol class="bar__queue-list">
        <li v-for="(item, i) in props.queued" :key="item + '-' + i" class="bar__queue-item">
          <span class="bar__queue-index">{{ i + 1 }}</span>
          <span class="bar__queue-text">{{ item.length > 48 ? item.slice(0, 48) + '…' : item }}</span>
          <button
            type="button"
            class="bar__queue-send"
            :disabled="props.riskyRunning"
            :title="props.riskyRunning ? tr('当前有等待确认的办理单，不能打断') : tr('打断当前任务并立即执行这一条')"
            @click="emit('immediate-send', item)"
          >
            {{tr('立即发送')}}
          </button>
          <button type="button" class="bar__queue-drop" :aria-label="tr('删除这条')" @click="emit('drop-queued', item)">×</button>
        </li>
      </ol>
      <p v-if="props.riskyRunning" class="bar__queue-warn">
        {{tr('当前有等待确认的办理单：为安全起见不允许打断，请先确认或取消它。')}}
      </p>
    </div>

    <p v-if="props.notice" class="bar__notice" role="status">{{ tr(props.notice) }}</p>

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

<style>
/* 输入行 DOM 在 ComposerBar 中。scoped 样式带 data-v 属性，
   子组件元素匹配不到，故本组件样式改为全局；类名均为 bar__* 前缀，不会外泄到别处。 */
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
  min-height: 84px;
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
  /* 输入区高度 60px，上限 210px，长问题更好读 */
  min-height: 60px;
  max-height: 210px;
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
  /* 示例问题单行横向滚动 —— 换行会把吸底栏撑到 250px+，挡住正文 */
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

/* 语音条：与输入框同高、吃满剩余宽度。
   为什么不是普通按钮样式——它替代的是输入框，必须让人一眼看出「这里是按住说话的位置」。 */
.bar__speak {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--text-muted);
  font: inherit;
  font-size: 13px;
  letter-spacing: 0.01em;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
}
.bar--hero .bar__speak {
  min-height: 84px;
}
.bar__speak:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 6%, var(--surface-2));
}
.bar__speak.is-active {
  border-style: solid;
  border-color: var(--primary);
  background: var(--primary-weak, #eef4ff);
  color: var(--primary);
}
.bar__speak.is-cancel {
  /* 不用 var(--danger)：暗色主题里它是 #d99a9a（淡粉），在深底上根本不像"取消" */
  border-style: solid;
  border-color: #e5484d;
  background: rgba(229, 72, 77, 0.14);
  color: #e5484d;
}
.bar__speak:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.bar__speak-text {
  font-weight: 500;
}

/* 停止：运行中占据发送按钮的位置，做成实底主按钮，避免与"发送"混淆 */
.bar__btn--stop {
  /* 不带红色：停止是常规操作，不是危险动作 */
  background: var(--surface-2);
  border-color: var(--border-strong, var(--border));
  color: var(--text);
  font-weight: 600;
}
.bar__btn--stop:hover:not(:disabled) {
  filter: brightness(0.94);
}

/* 录音遮罩：只压暗主内容区，不挡输入条本身（用户还要看到「松开取消」） */
.voice-mask {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(16, 20, 28, 0.42);
  backdrop-filter: blur(2px);
  pointer-events: none;
}
.voice-mask.is-cancel {
  background: rgba(120, 20, 18, 0.34);
}
.voice-mask__card {
  display: grid;
  justify-items: center;
  gap: 6px;
  min-width: 220px;
  padding: 18px 22px;
  border-radius: 16px;
  background: rgba(28, 32, 40, 0.92);
  color: #fff;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
}
.voice-mask.is-cancel .voice-mask__card {
  background: rgba(150, 28, 24, 0.94);
}
.voice-mask__wave {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 0 6px rgba(255, 255, 255, 0.18);
  animation: voice-pulse 1.1s ease-in-out infinite;
}
@keyframes voice-pulse {
  0%, 100% { transform: scale(0.85); opacity: 0.75; }
  50% { transform: scale(1.15); opacity: 1; }
}
.voice-mask__title {
  font-size: 15px;
  letter-spacing: 0.02em;
}
.voice-mask__hint {
  font-size: 12px;
  opacity: 0.82;
}
.voice-mask__time {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

/* 待执行队列：输入区上方，最多 3 条。视觉上压低存在感，但不能像日志一样灰到看不清 */
.bar__queue {
  display: grid;
  gap: 6px;
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.bar__queue-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}
.bar__queue-title {
  font-weight: 600;
}
.bar__queue-clear {
  margin-left: auto;
  border: 0;
  background: none;
  padding: 0;
  color: var(--text-muted);
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.bar__queue-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.bar__queue-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.bar__queue-index {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-3, rgba(0, 0, 0, 0.06));
  font-size: 11px;
  color: var(--text-muted);
}
.bar__queue-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar__queue-send {
  flex: 0 0 auto;
  border: 1px solid var(--primary);
  background: transparent;
  color: var(--primary);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
}
.bar__queue-send:disabled {
  border-color: var(--border);
  color: var(--text-faint, var(--text-muted));
  cursor: not-allowed;
}
.bar__queue-drop {
  flex: 0 0 auto;
  border: 0;
  background: none;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 4px;
}
.bar__queue-warn {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--warn, #b45309);
}
</style>
