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
  /**
   * 监听地址。默认 127.0.0.1（只有本机能访问）。
   * ⚠️ 不要默认监听 0.0.0.0：这个 API 会把请求转发给 Agnes，
   *    一旦配上 API Key，监听全网就等于把 Key 的消费能力开放给整个局域网。
   *    要在手机上调试时，显式设 HOST=0.0.0.0，并在用完后改回来。
   */
  host: string;
  /** DashScope（阿里云百炼）—— 仅聊天模式；models 按 fallback 顺序排列 */
  dashscope: {
    apiKey: string;
    baseUrl: string;
    models: string[];
  };
  /** Agnes 3.0 Flash —— 仅任务模式（工作模式） */
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
  /**
   * ops.v1 沙盒身份（任务书 §7.2 的最小版）。
   * 老系统没有可复用的登录体系 → 沙盒用演示身份：默认角色由 .env 决定，
   * 前端可在沙盒内切换演示视角（学生/志愿者/管理员），能力边界由服务端校验。
   * production 环境未接入；接入后此处必须换成真实身份委托，绝不能沿用演示身份。
   */
  sandbox: {
    defaultRole: 'admin' | 'volunteer' | 'student';
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  cached = {
    port: int('PORT', 8787, 1, 65535),
    host: str('HOST', '127.0.0.1'),
    agnes: {
      apiKey: str('AGNES_API_KEY'),
      model: str('AGNES_MODEL', 'agnes-3.0-flash'),
      baseUrl: str('AGNES_BASE_URL', 'https://api.agnes-ai.cn/v1').replace(/\/+$/, ''),
      timeoutMs: int('AGNES_TIMEOUT_MS', 45000, 1000, 300000),
      maxRetries: int('AGNES_MAX_RETRIES', 2, 0, 5),
      maxTokens: int('AGNES_MAX_TOKENS', 800, 64, 32768),
      temperature: Number(str('AGNES_TEMPERATURE', '0.3')),
      enableThinking: bool('AGNES_ENABLE_THINKING', false)
    },
    /**
     * DashScope（阿里云百炼）OpenAI 兼容端点 —— 2026-10-05 按负责人要求新增。
     * 用途：**仅聊天模式**使用，按 models 顺序依次 fallback（前面的不可用就换下一个）。
     * 顺序口径：负责人给的是界面自上而下的列表，要求**从下往上**依次调用 →
     * 故默认值按"最下面那个最先调用"排列。
     * 说明：这些模型名已用真实 Key 调 GET /models 逐一核对存在，不是猜的。
     */
    dashscope: {
      apiKey: str('DASHSCOPE_API_KEY'),
      baseUrl: str('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
      models: str('DASHSCOPE_MODELS', 'deepseek-v4-flash-0731,qwen3.8-max,qwen3.8-2.4t-a95b,deepseek-v4-pro-0813,kimi-k3,qwen3.8-27b,glm-5.3')
        .split(',').map((s) => s.trim()).filter(Boolean)
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
    sandbox: {
      defaultRole: (['admin', 'volunteer', 'student'] as const).includes(
        str('LABOPS_SANDBOX_ROLE', 'admin') as 'admin' | 'volunteer' | 'student'
      )
        ? (str('LABOPS_SANDBOX_ROLE', 'admin') as 'admin' | 'volunteer' | 'student')
        : 'admin'
    },
    logLevel: (str('LOG_LEVEL', 'info') as AppConfig['logLevel'])
  };
  return cached;
}

/** 给启动日志用：永远不打印 Key 本身，只说配置与否 */
export function describeConfig(c: AppConfig): string[] {
  return [
    `监听地址        : http://${c.host}:${c.port}${c.host === '0.0.0.0' ? '  ⚠️ 已开放到局域网' : ''}`,
    `Agnes 模型      : ${c.agnes.model} @ ${c.agnes.baseUrl}`,
    `Agnes API Key   : ${c.agnes.apiKey ? '已配置 ✓（仅服务端持有）' : '未配置 → 使用确定性规则引擎'}`,
    `模型分流        : 任务模式→Agnes${c.agnes.apiKey ? '' : '（未配置，回落规则引擎）'}；聊天模式→DashScope`,
    `DashScope 聊天链: ${c.dashscope.apiKey ? c.dashscope.models.join(' → ') + '（按序 fallback）' : '未配置 → 聊天模式回落规则引擎'}`,
    `步数/墙钟上限   : ${c.agent.maxSteps} 步 / ${c.agent.wallClockMs} ms`,
    `认证模式        : ${process.env.LABOPS_AUTH_MODE||'native'}`,
    ...((process.env.LABOPS_AUTH_MODE||'native')==='native'?['业务身份        : 主系统登录验证并自动委托，每次请求核验实际角色与班级']: [
      `实时数据开关    : ${c.data.live ? '开（LIVE_DATA=1，直接读 state.json）' : '关（脱敏快照）'}`,
      `沙盒演示身份    : ${c.sandbox.defaultRole}（仅明确开启的隔离demo）`
    ]),
    `日志级别        : ${c.logLevel}`
  ];
}
