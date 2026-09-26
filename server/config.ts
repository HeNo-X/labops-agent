/**
 * 运行配置 —— 所有可调参数集中在这里，且**都有安全默认值**
 * ============================================================================
 *  C6：凭据只从环境变量读取，禁止硬编码、禁止进日志。
 *  服务端启动时用 loadEnvFile 读项目根的 .env（不存在就跳过，不报错）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..');
export const SERVER_DIR = path.join(PROJECT_ROOT, 'server');

let envLoaded = false;
/** 只读一次 .env。没有任何依赖，避免为一个 20 行的解析器引入 dotenv。 */
function ensureEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch (err) {
      console.warn('[config] .env 解析失败，已忽略：', (err as Error).message);
    }
  }
}

function str(key: string, fallback = ''): string {
  ensureEnv();
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key: string, fallback: number, min: number, max: number): number {
  ensureEnv();
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(key: string, fallback: boolean): boolean {
  ensureEnv();
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export interface AppConfig {
  port: number;
  /** Agnes 3.0 Flash —— 产品运行时模型 */
  agnes: {
    apiKey: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
    maxRetries: number;
    maxTokens: number;
    temperature: number;
    enableThinking: boolean;
  };
  agent: {
    /** 单次任务最多几步（工具调用 + 收尾）。硬上限，不允许无界循环（C5） */
    maxSteps: number;
    /** 单次任务墙钟上限 */
    wallClockMs: number;
  };
  data: {
    /** true ⇒ 直接读真实 state.json（实时数据），仅本地/校内演示 */
    live: boolean;
    liveStatePath: string;
    snapshotPath: string;
    fallbackDemoPath: string;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  cached = {
    port: int('PORT', 8787, 1, 65535),
    agnes: {
      apiKey: str('AGNES_API_KEY'),
      model: str('AGNES_MODEL', 'agnes-3.0-flash'),
      baseUrl: str('AGNES_BASE_URL', 'https://apihub.agnes-ai.com/v1').replace(/\/+$/, ''),
      timeoutMs: int('AGNES_TIMEOUT_MS', 45000, 1000, 300000),
      maxRetries: int('AGNES_MAX_RETRIES', 2, 0, 5),
      maxTokens: int('AGNES_MAX_TOKENS', 800, 64, 32768),
      temperature: Number(str('AGNES_TEMPERATURE', '0.3')),
      enableThinking: bool('AGNES_ENABLE_THINKING', false)
    },
    agent: {
      maxSteps: int('AGENT_MAX_STEPS', 6, 1, 12),
      wallClockMs: int('AGENT_WALL_CLOCK_MS', 60000, 5000, 600000)
    },
    data: {
      live: bool('LIVE_DATA', false),
      liveStatePath: str('LABOPS_LIVE_STATE', path.join(SERVER_DIR, 'data', 'live', 'state.json')),
      snapshotPath: path.join(PROJECT_ROOT, 'seed', 'snapshot.json'),
      fallbackDemoPath: path.join(PROJECT_ROOT, 'seed', 'fallback-demo.json')
    },
    logLevel: (str('LOG_LEVEL', 'info') as AppConfig['logLevel'])
  };
  return cached;
}

/** 给启动日志用：永远不打印 Key 本身，只说配置与否 */
export function describeConfig(c: AppConfig): string[] {
  return [
    `端口            : ${c.port}`,
    `Agnes 模型      : ${c.agnes.model} @ ${c.agnes.baseUrl}`,
    `Agnes API Key   : ${c.agnes.apiKey ? '已配置 ✓（仅服务端持有）' : '未配置 → 进入演示引擎模式'}`,
    `步数/墙钟上限   : ${c.agent.maxSteps} 步 / ${c.agent.wallClockMs} ms`,
    `实时数据开关    : ${c.data.live ? '开（LIVE_DATA=1，直接读真实 state.json）' : '关（默认用脱敏快照）'}`,
    `日志级别        : ${c.logLevel}`
  ];
}
