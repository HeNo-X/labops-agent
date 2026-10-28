/**
 * 移动端手势层 —— 批次 C（方案 4.3）
 * ============================================================================
 *  · useSwipeBack：二级页左缘右滑返回（跟手位移 + 松手判定回弹/POP）
 *  · useDragClose：底部弹层拖拽关闭（顶部区域跟手，>120px 或快甩即关）
 *  · refreshBus + usePullToRefresh：滚动容器顶下拉刷新（>64px 松手触发，
 *    视图通过 refreshBus.register 注册各自的刷新函数）
 *  统一纪律：
 *   · Pointer Events（真机触摸与桌面测试同一路径；Playwright 鼠标即指针）
 *   · 轴向意图判定（首 8px 内 |dx|>|dy| 才算横向，反之纵向），避免与垂直滚动打架
 *   · 松手的回位/收拢动画走 CSS transition（reduced-motion 时由全局开关关闭）
 *   · 仅在移动壳内启用；不拦截输入控件上的起始手势
 */

import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ComputedRef, Ref, StyleValue } from 'vue';

/** 横向意图判定窗口（px）：首段位移决定轴向 */
const INTENT_WINDOW = 8;
/** 边缘热区宽度 */
const EDGE = 24;
/** 触发返回的最小位移/速度（px、px/ms） */
const BACK_DISTANCE = 80;
const BACK_VELOCITY = 0.5;
/** 弹层关闭阈值 */
const SHEET_DISTANCE = 120;
const SHEET_VELOCITY = 0.6;
/** 下拉刷新阈值 */
const PULL_DISTANCE = 64;

interface DragState {
  id: number;
  active: boolean;
  horizontal: boolean | null;
  vertical: boolean | null;
  x0: number;
  y0: number;
  t0: number;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  let el = target as HTMLElement | null;
  while (el) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
    el = el.parentElement;
  }
  return false;
}

// ---------------------------------------------------------------------------
//  边缘右滑返回
// ---------------------------------------------------------------------------

/**
 * 在 MobileApp 挂载：监听内容区左缘横向拖动，跟手平移 .mobile-view，
 * 松手达到阈值（位移或速度）调用 onBack（通常为 navigation.back）。
 * @param shouldTrack 返回当前是否处于可返回状态（二级页且无弹层/运行锁）
 */
export function useSwipeBack(container: () => HTMLElement | null, shouldTrack: () => boolean, onBack: () => void): void {
  let drag: DragState | null = null;
  let view: HTMLElement | null = null;
  let followed = 0;

  const clear = (animate: boolean): void => {
    if (view) {
      if (animate) view.style.transition = 'transform 180ms var(--m-ease, ease-out)';
      view.style.transform = '';
      const v = view;
      window.setTimeout(() => { v.style.transition = ''; }, 200);
    }
    view = null;
    followed = 0;
    drag = null;
  };

  const down = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!shouldTrack() || isInteractiveTarget(e.target)) return;
    if (e.clientX > EDGE) return;
    drag = { id: e.pointerId, active: true, horizontal: null, vertical: null, x0: e.clientX, y0: e.clientY, t0: performance.now() };
  };

  const move = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (drag.horizontal === null && drag.vertical === null) {
      if (Math.abs(dx) < INTENT_WINDOW && Math.abs(dy) < INTENT_WINDOW) return;
      if (Math.abs(dx) > Math.abs(dy)) drag.horizontal = true;
      else { clear(false); return; }
    }
    if (dx <= 0) { followed = 0; if (view) view.style.transform = ''; return; }
    if (!view) view = container()?.querySelector('.mobile-view') ?? null;
    if (!view) return;
    // 阻尼：越拉越重（前 160px 1:1，之后 0.35）
    followed = dx <= 160 ? dx : 160 + (dx - 160) * 0.35;
    view.style.transition = '';
    view.style.transform = `translateX(${Math.round(followed)}px)`;
  };

  const up = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const dt = performance.now() - drag.t0;
    const velocity = dt > 0 ? followed / dt : 0;
    if (followed >= BACK_DISTANCE || velocity >= BACK_VELOCITY) {
      clear(true);
      onBack();
    } else {
      clear(true);
    }
  };

  onMounted(() => {
    window.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up, { passive: true });
    window.addEventListener('pointercancel', () => drag && clear(false), { passive: true });
  });
  onUnmounted(() => {
    window.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  });
}

// ---------------------------------------------------------------------------
//  弹层拖拽关闭
// ---------------------------------------------------------------------------

export interface DragClose {
  /** 绑定到弹层根元素（v-on 对象语法：键必须是事件名，不是 onXxx props 命名） */
  handlers: {
    pointerdown: (e: PointerEvent) => void;
    pointermove: (e: PointerEvent) => void;
    pointerup: (e: PointerEvent) => void;
    pointercancel: () => void;
  };
  style: ComputedRef<StyleValue>;
}

/**
 * 拖拽关闭：只在弹层顶部 44px（grabber 区）起拖；跟手 translateY；
 * 松手 >SHEET_DISTANCE 或快甩 → 关闭（onClose），否则弹回。
 */
export function useDragClose(onClose: () => void): DragClose {
  const offset = ref(0);
  const animating = ref(false);
  let drag: DragState | null = null;
  let dy = 0;

  const reset = (): void => {
    drag = null;
    dy = 0;
    animating.value = true;
    offset.value = 0;
    window.setTimeout(() => (animating.value = false), 240);
  };

  // 响应式样式：offset 变化实时刷新 DOM（plain 对象只求值一次，拖动会"无反应"）
  const style = computed<StyleValue>(() => ({
    transform: offset.value ? `translateY(${Math.round(offset.value * 0.9)}px)` : undefined,
    transition: animating.value ? 'transform 200ms var(--m-ease, ease-out)' : 'none'
  }));

  return {
    handlers: {
      pointerdown(e: PointerEvent) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const el = e.currentTarget as HTMLElement;
        const rect = el.getBoundingClientRect();
        if (e.clientY - rect.top > 44) return; // 仅顶部 grabber 区起拖
        // 显式指针捕获：sheet 被拖离指针下方后，move/up 仍回本元素（触摸有隐式捕获，鼠标没有）
        el.setPointerCapture?.(e.pointerId);
        drag = { id: e.pointerId, active: true, horizontal: null, vertical: null, x0: e.clientX, y0: e.clientY, t0: performance.now() };
        animating.value = false;
      },
      pointermove(e: PointerEvent) {
        if (!drag || e.pointerId !== drag.id) return;
        dy = Math.max(0, e.clientY - drag.y0);
        offset.value = dy;
      },
      pointerup(e: PointerEvent) {
        if (!drag || e.pointerId !== drag.id) return;
        const dt = performance.now() - drag.t0;
        const velocity = dt > 0 ? dy / dt : 0;
        const close = dy >= SHEET_DISTANCE || velocity >= SHEET_VELOCITY;
        reset();
        if (close) onClose();
      },
      pointercancel: () => reset()
    },
    style
  };
}

// ---------------------------------------------------------------------------
//  下拉刷新
// ---------------------------------------------------------------------------

/** 视图注册刷新函数的轻量总线（key = route.view） */
const refreshHandlers = new Map<string, () => void | Promise<void>>();

export const refreshBus = {
  register(view: string, fn: () => void | Promise<void>): void {
    refreshHandlers.set(view, fn);
  },
  unregister(view: string): void {
    refreshHandlers.delete(view);
  },
  invoke(view: string): Promise<void> | void {
    return refreshHandlers.get(view)?.();
  }
};

/** 在视图内调用：注册/注销本视图的刷新函数（随生命周期） */
export function usePullRefreshRegistration(view: string, fn: () => void | Promise<void>): void {
  onMounted(() => refreshBus.register(view, fn));
  onUnmounted(() => refreshBus.unregister(view));
}

export interface PullToRefresh {
  /** 绑定到滚动容器（v-on 对象语法：键为事件名） */
  handlers: {
    pointerdown: (e: PointerEvent) => void;
    pointermove: (e: PointerEvent) => void;
    pointerup: (e: PointerEvent) => void;
    pointercancel: () => void;
  };
  /** 指示器状态：进度（0~1，超过阈值为 armed）与刷新中 */
  progress: Ref<number>;
  armed: ComputedRef<boolean>;
  refreshing: Ref<boolean>;
}

/**
 * 下拉刷新：滚动容器 scrollTop=0 时向下拖出指示器；松手达到阈值触发当前视图刷新。
 * @param enabled 当前视图是否启用（如 ['home','rooms','messages'].includes(view)）
 */
export function usePullToRefresh(scroller: () => HTMLElement | null, enabled: () => boolean, view: () => string): PullToRefresh {
  const progress = ref(0);
  const refreshing = ref(false);
  let drag: DragState | null = null;

  const armed = computed(() => progress.value >= 1);

  const settle = (): void => {
    drag = null;
    progress.value = 0;
  };

  return {
    handlers: {
      pointerdown(e: PointerEvent) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (!enabled() || refreshing.value) return;
        const el = scroller();
        if (!el || el.scrollTop > 0 || isInteractiveTarget(e.target)) return;
        drag = { id: e.pointerId, active: true, horizontal: null, vertical: null, x0: e.clientX, y0: e.clientY, t0: performance.now() };
      },
      pointermove(e: PointerEvent) {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x0;
        const dy = e.clientY - drag.y0;
        if (drag.vertical === null) {
          if (Math.abs(dx) < INTENT_WINDOW && Math.abs(dy) < INTENT_WINDOW) return;
          if (Math.abs(dy) > Math.abs(dx)) drag.vertical = true;
          else { drag = null; return; }
        }
        if (dy <= 0) { progress.value = 0; return; }
        // 阻尼 0.45：64px 阈值 ≈ 实际拖 142px
        progress.value = Math.min(1.6, (dy * 0.45) / PULL_DISTANCE);
      },
      pointerup(e: PointerEvent) {
        if (!drag || e.pointerId !== drag.id) return;
        const wasArmed = progress.value >= 1;
        settle();
        if (wasArmed) {
          const invoke = refreshBus.invoke(view());
          if (invoke instanceof Promise) {
            refreshing.value = true;
            invoke.finally(() => (refreshing.value = false));
          }
        }
      },
      pointercancel: settle
    },
    progress,
    armed,
    refreshing
  };
}
