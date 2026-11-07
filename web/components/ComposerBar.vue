<script setup lang="ts">
/**
 * ComposerBar —— 三处输入条的唯一实现（PC hero / PC dock / 移动端）
 * ============================================================================
 *  2026-11-07 从 CommandBar 与 MobileConversation 各搬一份出来合并。
 *  为什么必须合一：同一套"语音模式 / 长按说话 / 停止占位 / 继续发送"以前散在三处，
 *  改一处必漏另外两处（已真实发生：改了会话页、首页没改）。
 *
 *  职责边界（刻意收窄）：
 *   · 只管"输入行 + 语音模式 + 录音遮罩"；
 *   · 示例胶囊、待执行队列、提示条仍留在宿主（它们的布局位置各不相同）；
 *   · 不持有会话/运行状态，一律通过 props 与 emits 通信。
 */
import { computed, nextTick, ref } from 'vue';
import { t as tr } from '../i18n';
import UiIcon from './UiIcon.vue';
import { useVoiceInput } from '../composables/useVoiceInput';
import { useHoldToTalk } from '../composables/useHoldToTalk';
import { useVoiceCorrection } from '../composables/useVoiceCorrection';
import VoiceCorrectionBar from './VoiceCorrectionBar.vue';

const props = withDefaults(
  defineProps<{
    draft: string;
    /** 本轮正在跑：发送键换成停止，空输入时出现"继续发送" */
    busy?: boolean;
    /** 额外禁用（如会话列表加载失败） */
    disabled?: boolean;
    placeholder?: string;
    submitLabel?: string;
    variant?: 'hero' | 'dock' | 'mobile';
    inputId?: string;
    rows?: number;
    showCorrections?: boolean;
  }>(),
  {
    busy: false,
    disabled: false,
    placeholder: undefined,
    submitLabel: undefined,
    variant: 'dock',
    inputId: 'cmd',
    rows: 1,
    showCorrections: false
  }
);

const emit = defineEmits<{
  'update:draft': [string];
  submit: [];
  stop: [];
  queue: [string];
}>();

const isMobile = computed(() => props.variant === 'mobile');
const text = computed<string>({
  get: () => props.draft,
  set: (value) => emit('update:draft', value)
});

const voice = useVoiceInput();
const voiceFix = useVoiceCorrection(voice, text);
const voiceMode = ref(false);
const inputEl = ref<HTMLTextAreaElement | null>(null);

const hold = useHoldToTalk({
  voice,
  onText: (recognized: string) => {
    voiceFix.applyText(recognized);
    // 识别完成自动回到文本框：用户要的是"看到字、再确认发不发"
    voiceMode.value = false;
    void nextTick(() => inputEl.value?.focus());
  }
});

/** 与旧实现同口径的错误文案（不改语义，只搬家） */
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

const canSubmit = computed(() => Boolean(text.value.trim()) && !props.busy && !props.disabled);

function enterVoice(): void {
  if (props.busy || voice.working.value) return;
  voiceMode.value = true;
}

function exitVoice(): void {
  voiceMode.value = false;
  void nextTick(() => inputEl.value?.focus());
}

/** 统一提交口径：运行中就入队（不并发提交、也不丢输入），否则正常发送 */
function onSubmit(): void {
  const value = text.value.trim();
  if (!value) return;
  if (props.busy) {
    emit('queue', value);
    text.value = '';
    return;
  }
  emit('submit');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    onSubmit();
  }
}
</script>

<template>
  <form
    class="cb"
    :class="[isMobile ? 'mobile-composer' : 'bar__row', `cb--${variant}`]"
    @submit.prevent="onSubmit"
  >
    <!-- 录音状态条：既有实现就有，搬过来保持语义一致 -->
    <div v-if="voice.working.value" :class="isMobile ? 'mobile-voice-bar' : 'bar__voice'" role="status" aria-live="polite">
      <span :class="isMobile ? 'mobile-voice-dot' : 'bar__voice-dot'" aria-hidden="true"></span>
      <b>{{ tr(voice.status.value === 'transcribing' ? '识别中…' : voice.status.value === 'requesting' ? '等待麦克风…' : '正在聆听') }}</b>
      <span :class="isMobile ? 'mobile-voice-time' : 'bar__voice-time'">{{ Math.floor(voice.seconds.value) }}s / 60s</span>
    </div>

    <label class="sr-only" :for="inputId">{{ tr('输入你的实验室问题') }}</label>

    <button
      v-if="voice.supported.value && !voiceMode"
      type="button"
      :class="[isMobile ? 'mobile-mic' : 'bar__mic', { 'is-active': voice.working.value }]"
      :disabled="busy"
      :aria-label="tr('语音输入')"
      :title="tr('语音输入')"
      @click="enterVoice"
    >
      <UiIcon name="mic" />
    </button>
    <button
      v-else-if="voice.supported.value && voiceMode"
      type="button"
      :class="isMobile ? 'mobile-mic' : 'bar__mic'"
      :disabled="busy"
      :aria-label="tr('切换到键盘输入')"
      :title="tr('切换到键盘输入')"
      @click="exitVoice"
    >
      <UiIcon name="keyboard" />
    </button>

    <button
      v-if="voiceMode"
      type="button"
      :class="[
        isMobile ? 'mobile-speak' : 'bar__speak',
        { 'is-active': voice.status.value === 'recording', 'is-cancel': hold.sliding.value }
      ]"
      :style="hold.sliding.value ? { borderColor: '#e5484d', color: '#e5484d', background: 'rgba(229,72,77,0.14)', borderStyle: 'solid' } : undefined"
      :disabled="busy"
      :aria-label="tr('按住说话')"
      v-on="hold.handlers"
    >
      <UiIcon name="mic" />
      <span :class="isMobile ? '' : 'bar__speak-text'">{{
        tr(hold.sliding.value ? '松开取消' : voice.status.value === 'recording' ? '松开结束' : '按住说话')
      }}</span>
    </button>
    <textarea
      v-else
      :id="inputId"
      ref="inputEl"
      v-model="text"
      :class="isMobile ? '' : 'bar__input'"
      :rows="rows"
      :placeholder="busy ? tr('本轮还在执行，可先写下要补的一句（本轮结束后发送）') : (placeholder ?? '输入实验室问题或要办理的事项…')"
      :disabled="disabled || voice.working.value"
      @keydown="onKeydown"
    />

    <button
      v-if="!busy && !voiceMode"
      type="button"
      :class="isMobile ? 'mobile-primary' : 'bar__btn'"
      :disabled="!canSubmit"
      @click="onSubmit"
    >
      {{ tr(submitLabel ?? '发送') }}
    </button>
    <template v-else>
      <button
        v-if="!voiceMode && text.trim()"
        type="button"
        class="bar__btn bar__btn--queue"
        :class="{ 'is-hidden': isMobile }"
        :title="tr('加入待执行队列，本轮结束后按序自动发送')"
        @click="onSubmit"
      >
        {{ tr('继续发送') }}
      </button>
      <button
        v-if="!voiceMode"
        type="button"
        :class="isMobile ? 'cb__stop' : 'bar__btn bar__btn--stop'"
        @click="emit('stop')"
      >
        {{ tr('停止') }}
      </button>
    </template>

    <p v-if="voiceHint" :class="isMobile ? 'mobile-voice-hint' : 'bar__voice-hint'" role="alert">{{ voiceHint }}</p>

    <VoiceCorrectionBar
      v-if="showCorrections"
      :corrections="voice.lastCorrections.value"
      :original-text="voiceFix.originalText.value"
      :suppressed="voiceFix.suppressed.value"
      @restore="voiceFix.restore"
      @suppress="voiceFix.suppress"
      @unsuppress="voiceFix.unsuppress"
    />

    <!-- 录音遮罩：只在录音中/上滑取消时出现；文案按指针类型说对 -->
    <Teleport to="body">
      <div
        v-if="voice.status.value === 'recording' || hold.sliding.value"
        class="voice-mask"
        :class="{ 'is-cancel': hold.sliding.value }"
        role="status"
        aria-live="polite"
      >
        <div class="voice-mask__card">
          <span class="voice-mask__wave" aria-hidden="true"></span>
          <b class="voice-mask__title">{{ tr(hold.sliding.value ? '松开取消' : '正在聆听') }}</b>
          <span class="voice-mask__hint">
            {{
              tr(
                hold.sliding.value
                  ? hold.pointerKind.value === 'mouse'
                    ? '鼠标已上移，松开即放弃这段录音'
                    : '手指已上移，松手即放弃这段录音'
                  : '上滑可取消 · 松开结束并转成文字'
              )
            }}
          </span>
          <span class="voice-mask__time">{{ Math.floor(voice.seconds.value) }}s / 60s</span>
        </div>
      </div>
    </Teleport>
  </form>
</template>

<style scoped>
/* 遮罩（原在 CommandBar 的 scoped 样式里，搬到这里由所有宿主共享） */
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
/* 移动端停止键：宿主没有 bar__btn 体系，给一个中性样式 */
.cb__stop {
  padding: 0 14px;
  min-height: 44px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}
.is-hidden {
  display: none;
}
</style>
