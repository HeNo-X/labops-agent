/**
 * 跨会话并发控制 —— 全局 run 闸门（进程级并发上限 + FIFO 排队）
 * ============================================================================
 * 设计边界（务必先看，避免重复造轮子）：
 *  · **同一会话互斥不归本模块管**：由 `persistence/db.ts` 的
 *    `createMessageWithRun` / `RunConflictError`（同会话 running → 409 run_conflict）
 *    与前端（inputLocked 按会话、pending-input 队列）共同保证。
 *  · 本模块只回答一个问题：**同一进程最多允许几个 run 同时真的在跑**。
 *    超出上限时排队等待（不报错、不丢弃），避免并发把免费模型额度打爆。
 *  · run 的全部运行态仍是每请求局部（conversations.ts）；这里只登记
 *    `runId` 集合与等待队列，不持有任何执行上下文。
 *  · `AGENT_CONCURRENCY_GATE=0` 关闭闸门（完全不限流）。
 *
 * 队列纪律：FIFO、释放必走 `slot.release()`（调用方放在 finally 里）、
 * 客户端断开（AbortSignal）与等待超时都会把自己从队列里摘掉，绝不悬挂。
 */

export interface AcquireRunSlotInput {
  runId: string;
  conversationId: string;
  signal?: AbortSignal;
  /** 真正进入排队时调用一次：position = 前面还有几个任务 */
  onQueue?: (position: number) => void;
}

export interface RunSlot {
  readonly queued: boolean;
  /** 排队时前面还有几个；未排队为 0 */
  readonly position: number;
  readonly waitedMs: number;
  /** 幂等；必须在 finally 中调用 */
  release(): void;
}

/** 排队等待超过上限：调用方会把它转成可读的 run_failed（queue_timeout） */
export class RunQueueTimeoutError extends Error {
  readonly code = 'queue_timeout';
  constructor() {
    super('当前任务较多，排队等待超时，请稍后重试。');
    this.name = 'RunQueueTimeoutError';
  }
}

/** 客户端在排队期间断开：不是故障，调用方按 interrupted 收敛 */
export class RunQueueAbortedError extends Error {
  constructor() {
    super('排队期间连接已断开');
    this.name = 'RunQueueAbortedError';
  }
}

interface Waiter {
  runId: string;
  conversationId: string;
  enqueuedAt: number;
  signal?: AbortSignal;
  onQueue?: (position: number) => void;
  onAbort: () => void;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (slot: RunSlot) => void;
  reject: (err: Error) => void;
  settled: boolean;
  notified: boolean;
}

/** 进程级：正在执行的 runId 集合 + FIFO 等待队列 */
const active = new Set<string>();
const waiting: Waiter[] = [];

function intEnv(key: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[key] ?? '', 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

/** 每次现算（与 chain-plan/read-compose 的开关风格一致，便于测试与热调整） */
export function runGateConfig(): { enabled: boolean; maxConcurrent: number; queueWaitMs: number } {
  return {
    enabled: process.env['AGENT_CONCURRENCY_GATE'] !== '0',
    maxConcurrent: intEnv('AGENT_MAX_CONCURRENT_RUNS', 2, 1, 8),
    queueWaitMs: intEnv('AGENT_QUEUE_WAIT_MS', 30000, 1000, 120000)
  };
}

function clearWaiter(waiter: Waiter): void {
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.signal?.removeEventListener('abort', waiter.onAbort);
}

function grant(waiter: Waiter, track = true): void {
  if (waiter.settled) return;
  waiter.settled = true;
  clearWaiter(waiter);
  if (track) active.add(waiter.runId);
  let released = false;
  const slot: RunSlot = {
    queued: waiter.notified,
    position: 0,
    waitedMs: Date.now() - waiter.enqueuedAt,
    release: () => {
      if (released) return;
      released = true;
      active.delete(waiter.runId);
      pump();
    }
  };
  waiter.resolve(slot);
}

/** 从队首依次放行，直到达到并发上限；被取消/超时的条目会被跳过 */
function pump(): void {
  const cfg = runGateConfig();
  if (!cfg.enabled) {
    // 闸门关闭：连已在队列里的也全部放行，且不再登记活跃名额
    for (const waiter of waiting.splice(0)) grant(waiter, false);
    return;
  }
  for (let i = 0; i < waiting.length; ) {
    const waiter = waiting[i]!;
    if (waiter.settled) {
      waiting.splice(i, 1);
      continue;
    }
    if (!waiter.notified && active.size >= cfg.maxConcurrent) {
      waiter.notified = true;
      try {
        // position = 正在跑的 + 队列里排在自己前面的，给用户的是"前面还有几个任务"
        waiter.onQueue?.(active.size + i);
      } catch {
        /* 提示失败不影响排队正确性 */
      }
    }
    if (active.size >= cfg.maxConcurrent) break;
    waiting.splice(i, 1);
    grant(waiter);
  }
}

export async function acquireRunSlot(input: AcquireRunSlotInput): Promise<RunSlot> {
  const cfg = runGateConfig();
  if (!cfg.enabled) {
    // 运行中热改开关：新请求顺手把已在队列里的任务放走
    pump();
    return {
      queued: false,
      position: 0,
      waitedMs: 0,
      release: () => {
        pump();
      }
    };
  }
  const immediate = active.size < cfg.maxConcurrent && waiting.length === 0;
  if (immediate) {
    active.add(input.runId);
    let released = false;
    return {
      queued: false,
      position: 0,
      waitedMs: 0,
      release: () => {
        if (released) return;
        released = true;
        active.delete(input.runId);
        pump();
      }
    };
  }
  if (input.signal?.aborted) throw new RunQueueAbortedError();
  return new Promise<RunSlot>((resolve, reject) => {
    const waiter: Waiter = {
      runId: input.runId,
      conversationId: input.conversationId,
      enqueuedAt: Date.now(),
      signal: input.signal,
      onQueue: input.onQueue,
      onAbort: () => {},
      resolve,
      reject,
      settled: false,
      notified: false
    };
    waiter.onAbort = () => {
      if (waiter.settled) return;
      waiter.settled = true;
      clearWaiter(waiter);
      const i = waiting.indexOf(waiter);
      if (i >= 0) waiting.splice(i, 1);
      reject(new RunQueueAbortedError());
      pump();
    };
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      clearWaiter(waiter);
      const i = waiting.indexOf(waiter);
      if (i >= 0) waiting.splice(i, 1);
      reject(new RunQueueTimeoutError());
      pump();
    }, cfg.queueWaitMs);
    // 不 unref：排队超时的 Promise 必须有确定的落点；
    // 正常路径（获准/断开/超时/测试 reset）都会 clearTimeout，不会留悬挂 timer。
    input.signal?.addEventListener('abort', waiter.onAbort, { once: true });
    waiting.push(waiter);
    pump();
  });
}

/** 只读诊断位，也供测试断言（不泄露任何会话内容） */
export function runGateStats(): { enabled: boolean; maxConcurrent: number; active: number; waiting: number } {
  const cfg = runGateConfig();
  return { enabled: cfg.enabled, maxConcurrent: cfg.maxConcurrent, active: active.size, waiting: waiting.length };
}

/** 仅供测试：清空闸门状态（生产不要调用） */
export function resetRunGateForTests(): void {
  for (const waiter of waiting.splice(0)) {
    if (!waiter.settled) {
      waiter.settled = true;
      clearWaiter(waiter);
      waiter.reject(new RunQueueAbortedError());
    }
  }
  active.clear();
}
