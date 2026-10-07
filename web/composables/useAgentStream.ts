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

import SSE from '@shared/sse.js';
import { ref } from 'vue';
import type { RunEvent } from '@shared/types';
import { actorHeaders } from '../actor';

export interface StreamError {
  code: string;
  message: string;
  hint?: string;
}

export interface StartOptions {
  message: string;
  /** 本次任务的 runId（前端生成）。服务端全部事件回带它，store 据此做任务隔离 */
  runId?: string;
  /** 会话 id：服务端据此承接上一问的房间/日期 */
  sessionId?: string;
  /** 持久会话：消息落库到该会话（M1） */
  conversationId?: string;
  /** 幂等键：重复提交同一 clientRequestId 服务端返回 409，不重复执行（A15） */
  clientRequestId?: string;
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
    let durableTerminal=false;

    try {
      const res = await fetch(
        opts.conversationId
          ? `/api/conversations/${encodeURIComponent(opts.conversationId)}/messages`
          : '/api/agent/chat',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            // 沙盒演示身份随请求头传递（服务端校验并解析；模型参数不采信）
            ...actorHeaders()
          },
          body: JSON.stringify({
            message: opts.message,
            ...(opts.runId ? { runId: opts.runId } : {}),
            ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
            ...(opts.clientRequestId ? { clientRequestId: opts.clientRequestId } : {})
          }),
          signal: controller.signal
        }
      );

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
      const parser=SSE.createDecoder((ev:RunEvent)=>{if(SSE.terminal(ev))durableTerminal=true;opts.onEvent(ev);});
      for(;;){const {done,value}=await reader.read();if(done)break;parser.push(value);}
      parser.finish();
      if(!durableTerminal)opts.onError({code:'stream_ended_early',message:'连接中断或未确认历史保存，请保留内容并回查本会话，勿自动重发。'});
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
