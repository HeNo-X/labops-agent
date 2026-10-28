/**
 * 移动端反馈中心（批次 A）—— Toast + Promise 化确认弹层
 * ============================================================================
 *  · toast(text, action?)：瞬态提示（2.8s 自动消失），底部浮出、导航栏上方
 *  · confirmSheet(opts)：替代 window.confirm 的底部弹层确认（破坏性操作红色主按钮），
 *    返回 Promise<boolean>；这也是批次 D「确认弹层」的种子实现
 *  · 模块级响应式状态，任意组件可调用；宿主组件 ToastHost/ConfirmSheet 挂在 MobileApp
 */

import { reactive } from 'vue';

export interface ToastItem {
  id: number;
  text: string;
  actionLabel?: string;
  action?: () => void;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** destructive=true 时主按钮为红色（破坏性分级，方案 4.4） */
  destructive?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
  resolve: (ok: boolean) => void;
}

const state = reactive({
  toasts: [] as ToastItem[],
  confirm: { open: false, title: '', resolve: () => {} } as ConfirmState
});

let seq = 0;

/** F2：轻触觉反馈（渐进增强；不支持/系统关闭时静默跳过） */
function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* 忽略 */
  }
}

function toast(text: string, action?: { label: string; run: () => void }): void {
  const id = ++seq;
  buzz(6);
  state.toasts.push({ id, text, actionLabel: action?.label, action: action?.run });
  if (state.toasts.length > 3) state.toasts.shift();
  window.setTimeout(() => dismissToast(id), 2800);
}

function dismissToast(id: number): void {
  const i = state.toasts.findIndex((t) => t.id === id);
  if (i >= 0) state.toasts.splice(i, 1);
}

function confirmSheet(opts: ConfirmOptions): Promise<boolean> {
  if (state.confirm.open) state.confirm.resolve(false);
  return new Promise<boolean>((resolve) => {
    state.confirm = { ...opts, open: true, resolve };
  });
}

function answerConfirm(ok: boolean): void {
  if (ok) buzz(12); // 确认执行 = 最强一档反馈
  state.confirm.resolve(ok);
  state.confirm.open = false;
}

export function useFeedback() {
  return { state, toast, dismissToast, confirmSheet, answerConfirm };
}
