/**
 * POST /api/agent/chat —— SSE 事件流
 * ============================================================================
 *  协议（B3：先在文档里定死，前后端按同一份实现）：
 *    Content-Type: text/event-stream
 *    每条事件形如：
 *      event: <type>
 *      data: {"seq":0,"v":1,"runId":"…","type":"…","ts":"…","payload":{…}}
 *      <空行>
 *    - type 与 data.type 冗余一份：EventSource 用 event 名路由，fetch 流解析用 data。
 *    - seq 单调递增，前端据此去重与乱序重排。
 *    - 结束时额外发一条 `event: end`（不带业务语义），便于前端关闭流。
 *
 *  为什么不用 EventSource：EventSource 只能 GET，而聊天必须 POST 带 body；
 *  所以前端用 fetch + ReadableStream 消费，服务端仍然是标准 SSE 文本格式。
 */

import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { runAgent } from '../agent/run.ts';
import { newTraceId } from '../obs/trace.ts';
import { MAX_QUESTION_CHARS } from '../agent/prompts.ts';

const MAX_BODY_BYTES = 16 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; code: string; message: string; status: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (code: string, message: string, status: number): void => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, code, message, status });
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        fail('body_too_large', `请求体超过 ${MAX_BODY_BYTES} 字节上限`, 413);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => fail('body_read_error', '读取请求体失败', 400));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch {
        resolve({ ok: false, code: 'bad_json', message: '请求体不是合法 JSON', status: 400 });
      }
    });
  });
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 明确禁止中间层缓冲：cpolar / nginx 之类若开了 gzip 会攒包，流式就废了
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'identity'
  });
  // 立刻吐一个 2KB 注释，把代理的缓冲窗口顶开
  res.write(`: labops-agent sse stream open\n${':'.padEnd(2040, ' ')}\n\n`);
}

export async function handleAgentChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    res.writeHead(body.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: body.code, message: body.message }));
    return;
  }

  const payload = (body.value ?? {}) as Record<string, unknown>;
  const rawMessage = payload['message'] ?? payload['question'];
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: 'missing_message',
        message: `请求体需要 { "message": "..." }，且不能为空；最长 ${MAX_QUESTION_CHARS} 个字符`
      })
    );
    return;
  }

  const runId = typeof payload['runId'] === 'string' && payload['runId'] ? payload['runId'] : newTraceId('run');
  const sessionId = typeof payload['sessionId'] === 'string' && payload['sessionId'] ? payload['sessionId'] : undefined;

  sseHeaders(res);

  const ac = new AbortController();
  // 客户端断开 → 取消任务：中止 SSE 循环，并把这个 signal 传进 Agent 循环，
  // 让进行中的模型请求也立即停止（不烧 token、不产生新事件）
  req.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const send = (type: string, data: unknown): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 契约要求「每个事件都带单调递增的 seq」。end 是协议层收尾事件，不是业务事件，
  // 但也要带上 seq（取已发出事件的下一个值），否则前端的去重/排序判断会踩到 undefined。
  let lastSeq = -1;

  try {
    for await (const ev of runAgent({ question: rawMessage, runId, sessionId, signal: ac.signal })) {
      if (ac.signal.aborted) break;
      lastSeq = ev.seq;
      send(ev.type, ev);
    }
  } catch (err) {
    // runAgent 内部已把可预期错误转成 run_failed；走到这里说明是流本身出错
    lastSeq += 1;
    send('run_failed', {
      seq: lastSeq,
      v: 1,
      runId,
      type: 'run_failed',
      ts: new Date().toISOString(),
      payload: {
        code: 'stream_error',
        message: `事件流中断：${err instanceof Error ? err.message : String(err)}`,
        hint: '请重试；若持续失败，请检查服务端日志。'
      }
    });
  } finally {
    send('end', { seq: lastSeq + 1, v: 1, runId, type: 'end', ts: new Date().toISOString(), payload: { runId } });
    if (!res.writableEnded) res.end();
  }
}
