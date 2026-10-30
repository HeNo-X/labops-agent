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
        body: JSON.stringify({ audio, mime: payload.mime, seconds: Math.round(payload.seconds) })
      });
      if (!response.ok) {
        if (response.status === 503) errorCode.value = 'not_configured';
        else if (response.status === 429) errorCode.value = 'rate_limited';
        else if (response.status === 400) errorCode.value = 'unknown';
        else errorCode.value = 'upstream';
        return null;
      }
      const data = (await response.json()) as { text?: string };
      const text = (data.text ?? '').trim();
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

  return { status, seconds, errorCode, supported, recording, working, start, stop, cancel };
}
