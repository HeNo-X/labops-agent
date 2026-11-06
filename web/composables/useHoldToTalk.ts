/**
 * 长按说话（press-and-hold to talk）
 * ============================================================================
 *  为什么抽成 composable：PC 的 CommandBar 与移动端 MobileConversation 都要这个交互，
 *  各写一份必然分化（本仓库已被"同一能力两端各写一遍"坑过多次）。
 *
 *  交互契约：
 *    · 按下（pointerdown / 空格·回车 keydown）→ 请求麦克风并开始录音
 *    · 松手（pointerup / pointercancel / keyup）→ 停止并转写，文本交给调用方填入输入框
 *    · 按住不足 MIN_HOLD_MS 视为误触 → 直接取消，**不发请求**（省上游配额）
 *    · 松手早于权限弹窗返回 → 不会丢：start() 结束后自动收尾
 *    · 键盘同样可用（长按空格）—— 只有鼠标/触摸的长按是上不了无障碍的
 *
 *  为什么没做"边说边出字"（实时流式）：
 *    现有链路是「录完整段 → base64 → POST /api/agent/transcribe → 返回整段文本」。
 *    真流式要浏览器直连百炼 WebSocket —— 那会把 API Key 暴露到前端，不可接受；
 *    走服务端中转则要新增 WS 通道与流式配额模型。
 *    而"分段上传伪流式"会撞上 **每账号每小时 60 次** 的转写配额
 *    （见 server/api/transcribe.ts），2 秒一段的话两分钟就把配额烧光。
 *    所以本轮只做长按 + 松手回填，一次按住 = 一次请求。
 */

import { onUnmounted, ref } from 'vue';
import { useVoiceInput } from './useVoiceInput';

/** 低于这个时长按"误触"处理：取消录音且不发转写请求 */
const MIN_HOLD_MS = 350;

export interface HoldToTalkOptions {
  voice: ReturnType<typeof useVoiceInput>;
  /** 转写成功后拿到文本；调用方负责填进输入框 */
  onText: (text: string) => void;
}

export function useHoldToTalk(options: HoldToTalkOptions) {
  const voice = options.voice;
  const holding = ref(false);
  const tooShort = ref(false);

  let pressed = false;
  let arming = false;
  let startedAt = 0;
  let suppressClick = false;
  /**
   * 上滑取消（微信手感）：按下后手指上移超过阈值即进入"松开取消"态。
   * 阈值 60px 是经验值——小于这个数容易把音量抖动误判成取消。
   */
  const SLIDE_CANCEL_PX = 60;
  const sliding = ref(false);
  /** 本次长按是鼠标还是手指：遮罩文案要说对（PC 上写「手指」很怪） */
  const pointerKind = ref<'mouse' | 'touch'>('touch');
  let startY = 0;

  async function begin(): Promise<void> {
    if (pressed || voice.working.value) return;
    pressed = true;
    arming = true;
    startedAt = Date.now();
    tooShort.value = false;
    try {
      await voice.start();
    } finally {
      arming = false;
    }
    // 松手早于权限弹窗返回：start 结束后自动收尾，不能让用户的话白说
    if (!pressed) await settle();
  }

  async function settle(): Promise<void> {
    if (voice.status.value !== 'recording') return;
    const held = Date.now() - startedAt;
    if (held < MIN_HOLD_MS) {
      tooShort.value = true;
      voice.cancel();
      return;
    }
    const text = await voice.stop();
    if (text) options.onText(text);
  }

  async function end(): Promise<void> {
    if (!pressed) return;
    pressed = false;
    holding.value = false;
    if (arming) return; // start() 还没返回，交给 begin() 的收尾分支
    await settle();
  }

  function cancel(): void {
    pressed = false;
    holding.value = false;
    sliding.value = false;
    voice.cancel();
  }

  // ---------------- pointer（鼠标 / 触摸） ----------------
  function onPointerdown(event: PointerEvent): void {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    startY = event.clientY;
    pointerKind.value = event.pointerType === 'mouse' ? 'mouse' : 'touch';
    sliding.value = false;
    // 长按在移动端会触发选中/呼出菜单，必须拦掉
    event.preventDefault();
    try {
      (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    } catch {
      /* 某些环境不支持指针捕获，忽略即可 */
    }
    suppressClick = true;
    holding.value = true;
    void begin();
  }

  function onPointermove(event: PointerEvent): void {
    if (!holding.value) return;
    sliding.value = startY - event.clientY > SLIDE_CANCEL_PX;
  }

  function onPointerup(event: PointerEvent): void {
    try {
      (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
    } catch {
      /* 忽略 */
    }
    if (sliding.value) {
      cancel();
      return;
    }
    void end();
  }

  function onPointercancel(): void {
    sliding.value = false;
    void end();
  }

  /** 长按结束后浏览器还会补一个 click，吞掉它，否则会当成"再点一次" */
  function onClick(event: MouseEvent): void {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  // ---------------- keyboard（无鼠标场景） ----------------
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    if (event.repeat) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    holding.value = true;
    void begin();
  }

  function onKeyup(event: KeyboardEvent): void {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    void end();
  }

  onUnmounted(() => {
    if (pressed) cancel();
  });

  return {
    holding,
    tooShort,
    /**
     * 直接 `v-on="handlers"` 到按钮上。
     * ⚠️ 键名必须是 **DOM 事件名**（pointerdown / click…），不能写成 `onClick`：
     * Vue 的 v-on 对象语法按事件名 addEventListener，写 `onClick` 等于监听一个
     * 永远不会触发的事件 —— 按钮点了没反应（实测踩过）。
     */
    sliding,
    pointerKind,
    handlers: {
      pointerdown: onPointerdown,
      pointermove: onPointermove,
      pointerup: onPointerup,
      pointercancel: onPointercancel,
      click: onClick,
      keydown: onKeydown,
      keyup: onKeyup
    },
    begin,
    end,
    cancel
  };
}
