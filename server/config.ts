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
  // 测试要验证的是"给定 env → 链长什么样"这条纯函数关系，.env 是部署配置，
  // 不该参与单测。loadEnvFile 只补「未设置」的变量 —— 测试把变量删干净后反而会被
  // .env 全部补回（实测：夹具 3 个百炼模型，链里冒出 glm-4.7-flash / spark-x2.6-4b，
  // 且带真实 Key 真连外网）。LABOPS_SKIP_ENV_FILE=1 由测试入口统一注入。
  if (fs.existsSync(envPath) && process.env.LABOPS_SKIP_ENV_FILE !== '1') {
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
  /** 备用提供方 1：智谱 BigModel（两模式共用备用） */
  bigmodel: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  /** 备用提供方 2：讯飞星火 MaaS（工作模式第一备用 + 两模式末位备用；两模型共用一个 Key） */
  xfyun: {
    apiKey: string;
    baseUrl: string;
    taskModel: string;
    chatModel: string;
  };
  /** RAG 批次1：知识检索的向量召回（DashScope text-embedding，OpenAI 兼容端点；复用 DASHSCOPE_API_KEY） */
  embeddings: {
    enabled: boolean;
    model: string;
    dimensions: number;
    batchSize: number;
  };
  /** RAG 批次3：LLM 重排（对三路召回的 top 候选做一次打分重排；缺省关——配额敏感） */
  rerank: {
    llm: boolean;
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
  /**
   * 模型熔断：连续失败达阈值后让该模型冷却一段时间，避免每轮都白等一次。
   * 只统计"未吐出内容前"的失败，见 server/llm/circuit.ts。
   */
  circuit: {
    enabled: boolean;
    failureThreshold: number;
    cooloffMs: number;
    maxCooloffMs: number;
  };
  agent: {
    /** 单次任务最多几步（工具调用 + 收尾）。硬上限，不允许无界循环（C5） */
    maxSteps: number;
    /** 单次任务墙钟上限 */
    wallClockMs: number;
    /**
     * 上下文预算（确定性截断）。分母先用 window - outputReserve，
     * 因为模型的 context window 是 input+output 共享窗口。
     */
    context: {
      enabled: boolean;
      window: number;
      outputReserve: number;
      circuitBreakerAfter: number;
      thresholdRatio: number;
    };
  };
  /**
   * 视觉理解（多模态证据）。独立于任务/聊天两条主链路：
   * 主链路的模型不接图，图只走这一条受控通道，产出结构化观察而非自由文本。
   * 默认复用 DashScope 端点与 Key，但**模型名单独配**（聊天链那 7 个是纯文本模型）。
   * 未配置 Key ⇒ 工具如实返回"视觉未启用"，绝不用规则引擎冒充看图结果。
   */
  vision: {
    apiKey: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
    maxImages: number;
    maxImageBytes: number;
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
     * 用途：**仅聊天模式**使用（见 llm/router.ts：mode==='chat' 才走这里，工作模式只走 Agnes，
     *       两侧在代码结构上互斥，不存在"聊天模型被工作模式拿去用"的可能）。
     * 顺序口径：负责人给的是界面自上而下的列表，要求**从下往上**依次调用 →
     * 故默认值按"最下面那个最先调用"排列。
     * 说明：模型名已用真实 Key 调 GET /models 核对存在，且逐条实调 /chat/completions 验证可用。
     *
     * 2026-10-31 更替：上一批（deepseek-v4-flash-0731 / qwen3.8-max / qwen3.8-2.4t-a95b /
     * deepseek-v4-pro-0813 / qwen3.8-27b / glm-5.3）免费额度已全部耗尽（403
     * AllocationQuota.FreeTierOnly），逐条实调确认不可用 → 换成截图里这批新模型，
     * 截图自上而下：
     *   deepseek-v4.1-flash-1017 / deepseek-v4.1-flash / qwen3.8-max-0902 / qwen3.8-flash / kimi-k3
     *
     * ⚠️ 唯一偏离"自下而上"的地方：kimi-k3 从第 1 位挪到**最后**。实测三条硬理由：
     *   ① 它**不认 temperature**（400 InternalError.Algo.InvalidParameter）→ 每轮白跑一次
     *      （已在 llm/agnes.ts 加"摘参数重发"兜底，但没必要把每次请求都赌在兜底上）；
     *   ② 同样的问题它平均 **23~32 秒**，其余四个 1.5~4.4 秒；
     *   ③ 问「E310 今天的签到记录」它**不调工具**，直接回"请说明房间"，正是要避免的死路。
     *   其余 4 个严格自下而上。要完全照原顺序，把 kimi-k3 挪回第一位即可。
     */
    dashscope: {
      apiKey: str('DASHSCOPE_API_KEY'),
      baseUrl: str('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
      models: str('DASHSCOPE_MODELS', 'qwen3.8-flash,qwen3.8-max-0902,deepseek-v4.1-flash,deepseek-v4.1-flash-1017,kimi-k3')
        .split(',').map((s) => s.trim()).filter(Boolean)
    },
    /**
     * 备用提供方 1：智谱 BigModel（OpenAI 兼容 v4 端点）。
     * 角色：**聊天模式与工作模式共用的备用**——主链全挂时才轮到它（2026-10-31 负责人指定）。
     */
    bigmodel: {
      apiKey: str('BIGMODEL_API_KEY'),
      baseUrl: str('BIGMODEL_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, ''),
      model: str('BIGMODEL_MODEL', 'glm-4.7-flash')
    },
    /**
     * 备用提供方 2：讯飞星火 MaaS（v2 端点）。**两个模型共用一个 Key**。
     * 角色：`taskModel` 是**工作模式的第一备用**（Agnes 挂了下一次就用它），
     *       `chatModel` 是聊天/工作两种模式的**末位备用**。
     */
    xfyun: {
      apiKey: str('XFYUN_API_KEY'),
      baseUrl: str('XFYUN_BASE_URL', 'https://maas-api.cn-huabei-1.xf-yun.com/v2').replace(/\/+$/, ''),
      taskModel: str('XFYUN_TASK_MODEL', 'spark-x2.6'),
      chatModel: str('XFYUN_CHAT_MODEL', 'spark-x2.6-4b')
    },
    /**
     * RAG 批次1：知识检索向量召回。enabled 缺省关——生效需同时具备
     * DASHSCOPE_API_KEY 与已建索引（npm run knowledge:index）；任一不满足时
     * 检索自动退回关键词+BM25 两路，向量路任何失败都不影响检索本身。
     */
    embeddings: {
      enabled: bool('EMBEDDING_ENABLED', false),
      model: str('EMBEDDING_MODEL', 'text-embedding-v3'),
      dimensions: int('EMBEDDING_DIMENSIONS', 1024, 64, 4096),
      batchSize: int('EMBEDDING_BATCH_SIZE', 10, 1, 32)
    },
    rerank: {
      llm: bool('RERANK_LLM', false)
    },
    circuit: {
      enabled: bool('LLM_CIRCUIT_ENABLED', true),
      failureThreshold: int('LLM_CIRCUIT_THRESHOLD', 3, 1, 10),
      cooloffMs: int('LLM_CIRCUIT_COOLLOFF_MS', 20000, 1000, 600000),
      maxCooloffMs: int('LLM_CIRCUIT_MAX_COOLLOFF_MS', 300000, 5000, 3600000)
    },
    agent: {
      maxSteps: int('AGENT_MAX_STEPS', 6, 1, 12),
      wallClockMs: int('AGENT_WALL_CLOCK_MS', 60000, 5000, 600000),
      /**
       * 上下文预算（确定性截断，不做 LLM 摘要压缩）。
       * 关闭开关（CONTEXT_TRIM_ENABLED=0）时行为与改造前完全一致 —— 只保留决策可观测。
       */
      context: {
        enabled: bool('CONTEXT_TRIM_ENABLED', true),
        window: int('CONTEXT_WINDOW', 65536, 4096, 1048576),
        outputReserve: int('CONTEXT_OUTPUT_RESERVE_TOKENS', 8192, 0, 65536),
        /** 连续多少次"修剪后仍在阈值之上/失败"就不再尝试（熔断），避免每步都白算 */
        circuitBreakerAfter: int('CONTEXT_BREAKER_AFTER', 3, 1, 20),
        /** 估算口径下的告警阈值占比：超过它才判定 above_threshold */
        thresholdRatio: 0.75
      }
    },
    vision: {
      apiKey: str('VISION_API_KEY') || str('DASHSCOPE_API_KEY'),
      model: str('VISION_MODEL', 'qwen-vl-max-latest'),
      baseUrl: str('VISION_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
      timeoutMs: int('VISION_TIMEOUT_MS', 30000, 3000, 120000),
      maxImages: int('VISION_MAX_IMAGES', 3, 1, 8),
      maxImageBytes: int('VISION_MAX_IMAGE_BYTES', 3 * 1024 * 1024, 1024, 8 * 1024 * 1024)
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
    `备用链          : ${[c.bigmodel.apiKey ? `BigModel(${c.bigmodel.model})` : '', c.xfyun.apiKey ? `星火(${c.xfyun.taskModel}｜${c.xfyun.chatModel})` : ''].filter(Boolean).join(' + ') || '未配置（主链挂即回落规则引擎）'}`,
    `步数/墙钟上限   : ${c.agent.maxSteps} 步 / ${c.agent.wallClockMs} ms`,
    `视觉理解        : ${c.vision.apiKey ? `${c.vision.model} @ ${c.vision.baseUrl}（单次最多 ${c.vision.maxImages} 图）` : '未配置 → 证据照片不入模，工具如实说明不可得'}`,
    `认证模式        : ${process.env.LABOPS_AUTH_MODE||'native'}`,
    ...((process.env.LABOPS_AUTH_MODE||'native')==='native'?['业务身份        : 主系统登录验证并自动委托，每次请求核验实际角色与班级']: [
      `实时数据开关    : ${c.data.live ? '开（LIVE_DATA=1，直接读 state.json）' : '关（脱敏快照）'}`,
      `沙盒演示身份    : ${c.sandbox.defaultRole}（仅明确开启的隔离demo）`
    ]),
    `日志级别        : ${c.logLevel}`
  ];
}
