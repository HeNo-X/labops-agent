/**
 * useVoiceInput —— 语音输入前端组合式函数（录音 → 转写 → 文本）
 * ============================================================================
 *  全流程都在浏览器与自家服务端之间完成：
 *    getUserMedia 采集 → MediaRecorder 压缩（webm/opus 或 mp4）→
 *    base64 POST /api/agent/transcribe → 服务端 asr.ts 调模型 → 返回文本。
 *  音频不落盘、不进证据库；识别失败时错误码如实上抛，由界面诚实呈现。
 *
 *  使用方（MobileConversation / CommandBar）只需要：
 *    const voice = useVoiceInput();
 *    await voice.start();                 // 请求麦克风并开始录音（60s 自动收尾）
 *    const text = await voice.stop();     // 停止并转写，返回文本（失败返回 null，看 voice.errorCode）
 *    voice.cancel();                      // 丢弃录音
 */

import { computed, onUnmounted, ref } from 'vue';
import { clientFetch } from '../client';
import { currentUserTermPairs, currentKeywords } from './useUserTerms';

/**
 * 服务端回报的偏置真实状态（`bias` 字段）。界面只拿它说话，不拿"配置里开了"说话：
 * 配置开了但上游不收、或用户叫停了，applied 会照实是 false —— 差别必须看得见。
 */
/**
 * 上一次语音请求的真实偏置结果。放在模块级而不是 composable 实例里，
 * 因为「常用语音热词」面板位于 设置 → 个性化，与输入条不是同一棵组件树 ——
 * 用实例级 ref 的话面板只能拿到 null，界面就会显示一句错话。
 */
export const lastAsrBias = ref<VoiceBias | null>(null);
export const lastAsrProtocol = ref<string>('');

export interface VoiceBias {
  context?: boolean;
  options?: boolean;
  hotwords?: boolean;
  hotwordCount?: number;
  format?: boolean;
  degraded?: boolean;
  contextChars?: number;
  termsInContext?: number;
  omittedFromBudget?: number;
  hotwordsAvailable?: number;
  userKeywordsRegistered?: number;
  suppressedByUser?: boolean;
}

export type VoiceStatus = 'idle' | 'requesting' | 'recording' | 'transcribing';

export type VoiceErrorCode =
  | 'unsupported'      // 浏览器不支持 MediaRecorder / getUserMedia
  | 'insecure'         // 非安全上下文（getUserMedia 仅 https 或 localhost）
  | 'denied'           // 用户拒绝麦克风权限
  | 'no_device'        // 没有可用麦克风
  | 'busy'             // 已在录音/识别中重复触发
  | 'aborted'          // 用户取消
  | 'network'          // 请求失败（断网等）
  | 'not_configured'   // 服务端未配置 ASR_API_KEY
  | 'rate_limited'     // 每小时配额用尽
  | 'upstream'         // 上游识别服务出错
  | 'empty'            // 识别结果为空
  | 'unknown';

/** 服务端术语纠错的单条改动；via 说明靠什么判定的，界面用它决定措辞轻重 */
export interface VoiceCorrection {
  from: string;
  to: string;
  via: string;
}

export interface VoiceInputOptions {
  /** 单段录音上限（秒），到点自动收尾并转写 */
  maxSeconds?: number;
}

const MAX_SECONDS_DEFAULT = 60;

function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch { /* 某些实现不支持 isTypeSupported，继续尝试 */ }
  }
  return '';
}

export function useVoiceInput(options: VoiceInputOptions = {}) {
  const maxSeconds = options.maxSeconds ?? MAX_SECONDS_DEFAULT;
  const status = ref<VoiceStatus>('idle');
  const seconds = ref(0);
  const errorCode = ref<VoiceErrorCode | null>(null);
  /**
   * 上一次转写的服务端纠错结果。用并列 ref 而不是改 stop() 的返回类型：
   * stop() 目前有 PC/移动两端的长按封装共用，改签名会波及所有在制调用方。
   */
  const lastOriginalText = ref<string>('');
  const lastCorrections = ref<VoiceCorrection[]>([]);
  /** 用户点了"本页不再自动调整术语"后置真：后续请求停掉**词典自动**改动（用户自己登记的写法仍生效） */
  const suppressCorrection = ref<boolean>(false);

  const recording = computed(() => status.value === 'recording');
  const working = computed(() => status.value !== 'idle');
  /** 环境支持情况（不含权限：权限要在用户按下时才知道） */
  const supported = computed(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
    if (typeof MediaRecorder === 'undefined') return false;
    if (typeof window !== 'undefined' && window.isSecureContext === false) return false;
    return true;
  });

  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let mime = '';
  let tick = 0;
  let stopped: ((value: { blob: Blob; mime: string } | null) => void) | null = null;
  let cancelled = false;

  function cleanupMedia(): void {
    if (tick) { clearInterval(tick); tick = 0; }
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    recorder = null;
    chunks = [];
  }

  async function blobToBase64(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  async function transcribe(payload: { blob: Blob; mime: string; seconds: number }): Promise<string | null> {
    status.value = 'transcribing';
    try {
      const audio = await blobToBase64(payload.blob);
      const response = await clientFetch('/api/agent/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio,
          mime: payload.mime,
          seconds: Math.round(payload.seconds),
          // 用户明确说过"本页不再自动调整术语"，就按请求级别跳过**词典自动**纠错；
          // 他自己登记的词对不在停用范围内（服务端会照实分别标注）。
          ...(suppressCorrection.value ? { skipTermCorrect: true } : {}),
          // 登记过的写法随请求带上去：服务端只在本条转写里用，不落盘、不影响别人。
          // 词对（termPairs）走纠正层精确替换；常用词（extraTerms）只进事前偏置。
          // 两者为空时整个字段不出现，请求体保持最小形态。
          ...(() => {
            const termPairs = currentUserTermPairs();
            const extraTerms = currentKeywords();
            return {
              ...(termPairs.length ? { termPairs } : {}),
              ...(extraTerms.length ? { extraTerms } : {})
            };
          })()
        })
      });
      if (!response.ok) {
        if (response.status === 503) errorCode.value = 'not_configured';
        else if (response.status === 429) errorCode.value = 'rate_limited';
        else if (response.status === 400) errorCode.value = 'unknown';
        else errorCode.value = 'upstream';
        return null;
      }
      const data = (await response.json()) as {
        text?: string;
        originalText?: string;
        corrections?: Array<{ from: string; to: string; kind?: string; via?: string }>;
        bias?: unknown;
        protocol?: string;
      };
      const text = (data.text ?? '').trim();
      // 服务端只在真的改过时才回传 originalText/corrections；这里原样接住给界面展示。
      // 不接就等于把"替你改了两个字"这件事藏起来 —— 用户有权知道并且一键还原。
      lastCorrections.value = Array.isArray(data.corrections)
        ? data.corrections
          .filter((c) => typeof c?.from === 'string' && typeof c?.to === 'string' && c.from !== c.to)
          .map((c) => ({ from: c.from, to: c.to, via: c.via ?? 'unknown' }))
        : [];
      lastOriginalText.value = lastCorrections.value.length ? (data.originalText ?? '') : '';
      // 偏置的真实状态：常用词面板靠它说"这次到底发没发出去"，所以没有就是 null，不填默认值。
      lastAsrBias.value = data.bias && typeof data.bias === 'object' ? (data.bias as VoiceBias) : null;
      lastAsrProtocol.value = typeof data.protocol === 'string' ? data.protocol : '';
      if (!text) {
        errorCode.value = 'empty';
        return null;
      }
      return text;
    } catch {
      errorCode.value = 'network';
      return null;
    }
  }

  /** 请求麦克风并开始录音；失败时 errorCode 指明原因 */
  async function start(): Promise<void> {
    if (working.value) {
      errorCode.value = 'busy';
      return;
    }
    errorCode.value = null;
    // 每次重新录音都清掉上一轮的改动记录，否则提示行会说这轮没做过的事
    lastOriginalText.value = '';
    lastCorrections.value = [];
    // 偏置状态同理：新录音没结果之前，面板不该继续显示上一轮"发没发出去"
    lastAsrBias.value = null;
    lastAsrProtocol.value = '';
    if (!supported.value) {
      errorCode.value = typeof window !== 'undefined' && window.isSecureContext === false ? 'insecure' : 'unsupported';
      return;
    }
    status.value = 'requesting';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      errorCode.value = name === 'NotFoundError' || name === 'OverconstrainedError' ? 'no_device' : 'denied';
      status.value = 'idle';
      return;
    }
    mime = pickRecorderMime();
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      errorCode.value = 'unsupported';
      status.value = 'idle';
      cleanupMedia();
      return;
    }
    mime = recorder.mimeType || mime || 'audio/webm';
    chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime });
      const result = blob.size > 0 ? { blob, mime } : null;
      cleanupMedia();
      stopped?.(result);
      stopped = null;
    };
    recorder.start(250);
    seconds.value = 0;
    status.value = 'recording';
    tick = window.setInterval(() => {
      seconds.value = Math.min(maxSeconds, seconds.value + 0.2);
      if (seconds.value >= maxSeconds) void finish();
    }, 200);
  }

  /** 停止录音并把音频交给服务端转写；返回文本或 null（看 errorCode） */
  function stop(): Promise<string | null> {
    return finish();
  }

  function finish(): Promise<string | null> {
    if (status.value !== 'recording' || !recorder) return Promise.resolve(null);
    const recorded = recorder;
    const elapsed = seconds.value;
    status.value = 'transcribing';
    return new Promise((resolve) => {
      stopped = (result) => {
        if (cancelled || !result) {
          cancelled = false;
          status.value = 'idle';
          resolve(null);
          return;
        }
        void transcribe({ ...result, seconds: elapsed }).then((text) => {
          status.value = 'idle';
          resolve(text);
        });
      };
      // ondataavailable 的最后一包由 stop() 触发；requestData 保证收尾包完整
      try { recorded.requestData(); } catch { /* 部分实现不支持，忽略 */ }
      recorded.stop();
    });
  }

  /** 丢弃当前录音，不做转写 */
  function cancel(): void {
    if (status.value === 'idle') return;
    cancelled = true;
    errorCode.value = 'aborted';
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else { cleanupMedia(); stopped?.(null); stopped = null; }
    status.value = 'idle';
  }

  onUnmounted(() => {
    cancelled = true;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* 已停止 */ }
    }
    cleanupMedia();
  });

  /** 用户选择"还原原文"后调用：清掉提示，避免同一批改动被反复提示 */
  function clearCorrections(): void {
    lastCorrections.value = [];
    lastOriginalText.value = '';
  }

  /** 用户选择"本页不再自动调整术语"：关掉后续请求的纠错，并清掉当前提示 */
  function suppressCorrections(): void {
    suppressCorrection.value = true;
    clearCorrections();
  }

  /** 撤回上面的选择。抑制状态必须能取消 —— 只给开关不给回头路不是"决定权在用户" */
  function unsuppressCorrections(): void {
    suppressCorrection.value = false;
  }

  return {
    status, seconds, errorCode, supported, recording, working, start, stop, cancel,
    lastOriginalText, lastCorrections,
    suppressCorrection, clearCorrections, suppressCorrections, unsuppressCorrections
  };
}
