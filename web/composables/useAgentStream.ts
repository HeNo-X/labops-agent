/**
 * SSE 事件流消费
 * ============================================================================
 *  难点 6 的三条对策都在这里：
 *    ① 用明确的事件类型解析，不靠猜文本
 *    ② 用 TextDecoder({stream:true}) 增量解码 —— 中文 UTF-8 会被任意切断，
 *       逐块 toString() 一定出乱码或漏字（这是最容易踩的坑）
 *    ③ 用 seq 去重，允许乱序重排
 *
 *  为什么不用 EventSource：EventSource 只能 GET，聊天必须 POST 带 body。
 *  fetch + ReadableStream 是等价方案，服务端仍是标准 SSE 文本格式。
 */

import { ref } from 'vue';
import type { RunEvent } from '@shared/types';

export interface StreamError {
  code: string;
  message: string;
  hint?: string;
}

export interface StartOptions {
  message: string;
  onEvent: (ev: RunEvent) => void;
  onError: (err: StreamError) => void;
  onClose: () => void;
}

export function useAgentStream() {
  const streaming = ref(false);
  let controller: AbortController | null = null;

  function cancel(): void {
    controller?.abort();
  }

  async function start(opts: StartOptions): Promise<void> {
    controller = new AbortController();
    streaming.value = true;
    let lastSeq = -1;

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ message: opts.message }),
        signal: controller.signal
      });

      if (!res.ok) {
        // 服务端在建立事件流之前失败 → 返回的是 JSON 错误体
        let payload: StreamError = { code: `http_${res.status}`, message: `服务端返回 HTTP ${res.status}` };
        try {
          const j = (await res.json()) as Record<string, unknown>;
          payload = {
            code: String(j['error'] ?? payload.code),
            message: String(j['message'] ?? payload.message)
          };
        } catch {
          /* 保持默认 payload */
        }
        opts.onError(payload);
        return;
      }

      if (!res.body) {
        opts.onError({ code: 'empty_body', message: '服务端未返回事件流（响应体为空）' });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // stream:true 是关键 —— 否则一个中文字被切成两半时会出现 U+FFFD
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        // SSE 以空行分隔消息块
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue; // 忽略 `event:` 行与注释行
            const raw = line.slice(6);
            let ev: RunEvent;
            try {
              ev = JSON.parse(raw) as RunEvent;
            } catch {
              continue; // 单个坏块不该毁掉整个回答
            }
            // seq 去重：网络重传或代理重放时不会出现重复气泡
            if (typeof ev.seq === 'number') {
              if (ev.seq <= lastSeq) continue;
              lastSeq = ev.seq;
            }
            opts.onEvent(ev);
          }
        }
      }
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') {
        opts.onError({ code: 'run_cancelled', message: '任务已取消。' });
      } else {
        opts.onError({
          code: 'network_error',
          message: `无法连接服务端：${e.message}`,
          hint: '请确认服务端已启动（npm run dev 或 npm run dev:server），然后重试。'
        });
      }
    } finally {
      streaming.value = false;
      controller = null;
      opts.onClose();
    }
  }

  return { streaming, start, cancel };
}
