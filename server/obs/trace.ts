/**
 * 可观测性底座 —— trace_id 贯穿 + 结构化日志 + PII 脱敏
 * ============================================================================
 *  Phase 4 要求：trace_id 贯穿、关键指标可查、日志脱敏。
 *  C6 要求：凭据/PII 不得进入日志。
 *
 *  这里的 redact() 是**最后一道防线**：即使上游忘了脱敏，日志也不会泄漏。
 */

import crypto from 'node:crypto';
import { getConfig } from '../config.ts';

export const APP_TZ = 'Asia/Shanghai';

export function newTraceId(prefix = 'run'): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVEL_ORDER;

/**
 * 脱敏：手机号、长数字串（学号）、疑似 token/key、以及任何显式传入的密钥值。
 * 注意：只影响日志输出，不改动业务数据。
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(api[-_]?key|authorization|password|token|secret|cookie)$/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

function redactString(s: string): string {
  let out = s;
  // 手机号
  out = out.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, (m) => `${m.slice(0, 3)}****${m.slice(7)}`);
  // 学号 / 长数字串
  out = out.replace(/(?<!\d)\d{10,14}(?!\d)/g, (m) => `${m.slice(0, 3)}***${m.slice(-2)}`);
  // 常见密钥前缀
  out = out.replace(/\b(sk|ak|pk)-[A-Za-z0-9_-]{8,}/g, '$1-[REDACTED]');
  // 已配置的真实 Key（哪怕它不符合上面的模式，也一律抹掉）
  const { agnes } = getConfig();
  if (agnes.apiKey && agnes.apiKey.length >= 6) {
    out = out.split(agnes.apiKey).join('[REDACTED]');
  }
  return out;
}

function emit(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  let configured: LogLevel = 'info';
  try {
    configured = getConfig().logLevel;
  } catch {
    /* 配置尚未就绪时退化为 info */
  }
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configured]) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(redact(fields) as Record<string, unknown>)
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export interface Logger {
  debug: (event: string, fields?: Record<string, unknown>) => void;
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
  error: (event: string, fields?: Record<string, unknown>) => void;
}

/** 每个 trace 一个 logger，自动带上 traceId，避免手工到处传 */
export function loggerFor(traceId: string, base: Record<string, unknown> = {}): Logger {
  const wrap =
    (level: LogLevel) =>
    (event: string, fields: Record<string, unknown> = {}): void =>
      emit(level, event, { traceId, ...base, ...fields });
  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error')
  };
}

/** 简单耗时器，给 span 埋点用 */
export class Stopwatch {
  private readonly t0 = Date.now();
  get ms(): number {
    return Date.now() - this.t0;
  }
}
