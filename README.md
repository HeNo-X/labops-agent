# LabOps Agent · 实验室任务画布

> 用一句话完成实验室运维查询。第一阶段（本仓库当前状态）打通一条纵向链路：
> **一句话输入 → 任务进度可视化 → 只读工具查课表 → 课程结果 + 数据来源标识。**

来源项目：本校在用的实验室管理系统（真实场景、真实数据、已公网部署）。
本仓库是**全新独立仓库**，不合并老系统的 Git 历史（老历史含旧版凭据）。

---

## 快速开始

```bash
# 环境要求：Node >= 22.18（用到原生 TypeScript 类型剥离，不依赖 tsx/esbuild）
node -v

npm install
cp .env.example .env          # 按需填写，留空即为演示模式
npm run dev                   # 同时起服务端(8787) + 前端(5173)

# 打开 http://127.0.0.1:5173
```

> 直接 `http://127.0.0.1:5173` 即可，Vite 已把 `/api` 代理到服务端 8787，**不需要单独访问服务端端口**。

### 生产模式（单进程托管前端产物）

```bash
npm run build     # vue-tsc 类型检查 + vite build → dist/
npm start         # node server/index.ts，同时托管 dist/ 与 API
# 打开 http://127.0.0.1:8787
```

### 常用脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 服务端 + 前端一起起（零依赖自研并发脚本） |
| `npm run dev:server` | 只起服务端（`node --watch`） |
| `npm run dev:web` | 只起 Vite |
| `npm run build` | 类型检查 + 前端构建 |
| `npm start` | 生产启动（API + 静态托管） |
| `npm run typecheck` | 前后端全量类型检查 |
| `npm run seed -- <state.json>` | 从真实数据生成脱敏快照 |
| `npm test` | 单元测试（35 条） |
| `npm run test:acceptance` | 端到端验收（打真实 SSE 接口，33 项） |
| `npm run test:browser` | 真实浏览器验收（桌面 + 手机，32 项） |
| `npm run test:all` | 上面三套全跑 |

---

## 当前运行状态（2026-09-26 实测）

| 项 | 值 |
|---|---|
| 推理引擎 | **演示引擎**（未配置 `AGNES_API_KEY`）—— 服务端规则解析，未调用大模型 |
| 数据来源 | **脱敏快照**（`seed/snapshot.json`） |
| 数据规模 | 实验室 10 + 开放实验室 6 / 课表 **139** 条 / 学期 `2026-2027-1`，起始日 `2026-09-07` |
| 已注册工具 | **1 个**：`query_schedule`（只读） |
| 测试 | 单元 35/35 ｜ 端到端 33/33 ｜ 浏览器 32/32 |

**为什么现在是演示引擎**：`AGNES_API_KEY` 未配置。
Agnes 适配层已完整实现（`server/llm/agnes.ts`，OpenAI 兼容 `POST /v1/chat/completions`），
端点可达性已实测（用无效 Key 打过去，返回 HTTP 401 `AgnesAI_error`），但**带有效 Key 的工具调用链路未端到端验证过** —— 见文末"待确认"。

---

## 环境变量

见 `.env.example`，全部有安全默认值。要点：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGNES_API_KEY` | 空 | **仅服务端读取，浏览器永远拿不到**。留空 = 演示引擎 |
| `AGNES_MODEL` | `agnes-3.0-flash` | 产品运行时模型 |
| `AGNES_BASE_URL` | `https://apihub.agnes-ai.com/v1` | OpenAI 兼容 |
| `PORT` | `8787` | 服务端端口 |
| `AGENT_MAX_STEPS` | `6` | 单次任务工具调用步数上限（硬上限，见 §健壮性） |
| `AGENT_WALL_CLOCK_MS` | `60000` | 单次任务墙钟上限 |
| `AGNES_TIMEOUT_MS` | `45000` | 单次 Agnes 调用超时 |
| `AGNES_MAX_RETRIES` | `2` | 失败重试次数（指数退避 + 抖动） |
| `LIVE_DATA` | 空 | `1` = 直接读真实 `state.json`（仅本地/校内演示） |
| `LABOPS_LIVE_STATE` | `server/data/live/state.json` | 真实 `state.json` 路径，已 `.gitignore` |

---

## 架构

```
labops-agent/
├── index.html                  Vite 入口
├── shared/                     ★ 前后端共用的唯一事实来源
│   ├── periods.ts              六节次定义 + weekday 语义（老系统曾硬编码 6 份，这里只有 1 份）
│   └── types.ts                SSE 事件契约 / 工具契约 / 数据来源标识
├── server/                     AI 接入层（原生 node:http，不用 Express）
│   ├── index.ts                HTTP 入口 + 静态托管（白名单式，见 §安全）
│   ├── config.ts               配置集中处，全部有默认值
│   ├── api/agent-chat.ts       POST /api/agent/chat → SSE
│   ├── agent/
│   │   ├── run.ts              有界自主循环（两条引擎路径产出同构事件流）
│   │   ├── intent.ts           中文时间/房间指代解析（★ 日期绝不让模型算）
│   │   ├── demo-engine.ts      无 Key 时的确定性规则引擎
│   │   └── prompts.ts          System Prompt + 输入净化 + 注入检测（含版本号）
│   ├── llm/agnes.ts            Agnes 3.0 Flash 适配器（流式 + 工具调用 + 重试）
│   ├── tools/
│   │   ├── registry.ts         工具注册表 + JSON Schema + 白名单校验
│   │   └── query-schedule.ts   ★ 只读工具，与模型层完全解耦
│   ├── data/store.ts           live / snapshot / demo 三态载入 + 载入时伪名化
│   ├── time/term.ts            教学周与节次解算（Asia/Shanghai）
│   └── obs/trace.ts            trace_id + 结构化日志 + PII 脱敏
├── web/                        任务画布（Vue 3 + Pinia + TS）
│   ├── App.vue                 外壳与布局
│   ├── stores/run.ts           显式六态状态机
│   ├── composables/            SSE 消费（UTF-8 增量解码 + seq 去重）
│   ├── components/             LabMatrix / RunTrace / ScheduleResult / CommandBar / ConfirmDock / …
│   └── styles/tokens.css       独立视觉令牌（不靠颜色区分状态）
├── seed/
│   ├── make-snapshot.ts        从真实 state.json 生成脱敏快照（含残留自检）
│   ├── snapshot.json           脱敏快照（入库）
│   └── fallback-demo.json      模拟演示兜底（DEMO- 前缀，不可能被误认）
├── tests/
│   ├── unit.test.ts            35 条：日期/单双周/参数校验/无数据/来源标记
│   ├── acceptance.ts           33 条：打真实 SSE 接口
│   └── browser.ts              32 条：真实 Chrome，桌面 + 手机
└── docs/
    ├── first-stage-design.md   设计说明（一页）
    └── data-contract.md        数据契约
```

### 技术选型与理由

| 层 | 选择 | 版本 | 理由 |
|---|---|---|---|
| 框架 | Vue 3 + TypeScript | `vue@3.5.43` / `typescript@5.9.3` | 赛道推荐栈，TS 是明写的评分项 |
| 状态 | Pinia | `pinia@4.0.3` | 轻量、TS 友好，用来承载显式状态机 |
| 构建 | Vite | `vite@8.3.1` | 产物 gzip 后 **38.5 kB JS + 4.3 kB CSS** |
| 服务端 | 原生 `node:http` | Node ≥ 22.18 | 3 个端点不值得引入 Express 与它的传递依赖 |
| TS 运行 | **Node 原生类型剥离** | — | 不依赖 `tsx`/`esbuild`：少两个依赖，也少一类 postinstall 装不上的故障 |
| 样式 | 原生 CSS 变量 | — | 不引 Tailwind：本项目不需要它，而且能省掉一层构建配置 |
| 浏览器测试 | `playwright-core` | `1.63.0` | **不下载浏览器**，复用本机已装的 Chrome / Edge |

---

## 数据来源（三态）

| sourceType | 界面标识 | 含义 | 何时出现 |
|---|---|---|---|
| `live` | ⚡ 实时数据 | 直接读真实 `state.json` | `LIVE_DATA=1` 且文件存在 |
| `snapshot` | ▣ 脱敏快照 | 从真实数据导出后已脱敏，**非实时** | 默认 |
| `demo` | ◇ 模拟演示 | 内置构造的示例数据，与真实实验室无关 | `seed/snapshot.json` 缺失 |

**引擎**（`agnes` / `demo`）与**数据来源**是两个正交维度，界面上分开显示。
例如当前状态就是"脱敏快照 + 演示引擎"——这种组合必须被如实说出来，不能含糊成一个"AI 查课表"。

### 导入真实数据

```bash
# 1) 从服务器取真实 state.json（不要放进本仓库）
# 2) 生成脱敏快照
npm run seed -- /绝对路径/state.json
```

脚本会做三件事：① 只保留 `labs`/`openLabs`/`timetable`/`sysConfig` 四张表；
② 73 个真实教师姓名稳定伪名化为 `教师Txx`；③ **残留自检**——命中手机号 / 学号 / 真实姓名任一即拒绝写文件。

详细字段与脱敏策略见 [`docs/data-contract.md`](docs/data-contract.md)。

---

## 第一阶段能力边界

**能做**：查某房间某天的排课（含合班、单双周、节次过滤、假期、停课），并给出数据来源与依据。

**不能做（明确说了"做不到"而不是编一个答案）**：

- 签到人数 / 在室人数（线上三类签到记录当前都是 0）
- 钥匙位置、值班名册
- 知识库问答（RAG 不在第一阶段范围）
- 发布通知、创建工单（**零写操作**，确认位只有禁用的骨架）
- 历史统计（数据只覆盖当前学期）
- 不指定房间号的全量扫描

---

## 健壮性设计（对应硬约束）

| 约束 | 落地位置 | 具体做法 |
|---|---|---|
| **有界自主** | `agent/run.ts` | 四个停止条件：`max_steps`(6) / 墙钟(60s) / 无工具调用 / 重复调用检测（同工具同参数 2 次即打断）。绝无 `while(true)` |
| **超时+重试+降级** | `llm/agnes.ts` | 每次调用 `AbortController` 超时；仅对**尚未产出任何文字**的失败重试（流一旦开始就不再重试，否则会拼出重复内容）；指数退避 + 抖动；401/400/404 判定为不可重试 |
| **不静默降级** | 全局 | 配了 Key 但调用失败 → 报**真实错误码**，绝不悄悄换回演示引擎 |
| **未知工具可恢复** | `tools/registry.ts` | 不在白名单的工具返回 `ok:false` + 可用工具清单，让模型有一次自我纠正机会，而不是抛异常中断 |
| **参数服务端校验** | `tools/registry.ts` | `coerceQueryScheduleArgs()` 丢弃类型不符的字段；房间号必须命中已收录列表 |
| **凭据安全** | `config.ts` + `obs/trace.ts` | Key 只从环境变量读；日志层有独立 `redact()`（手机号/学号/`sk-*`/已配置的 Key 全抹掉） |
| **PII 不落库** | `data/store.ts` | 载入时伪名化教师姓名——**真实姓名从不进入进程的业务对象** |
| **反幻觉** | `agent/prompts.ts` + `run.ts` | Prompt 分"能查的/能答的/绝不做的"三类；工具结果回灌时附注释"notes 必须原样转达"；若模型回答里出现"实时"而来源不是 live，自动追加更正 |
| **提示注入** | `agent/prompts.ts` | 命中注入句式时**不硬拒绝**（会误伤"忽略上面那个实验室"这类正常话），而是把用户输入降级为纯数据并留痕；真正的防线是服务端工具白名单 |
| **可观测** | `obs/trace.ts` | `traceId` 贯穿；结构化日志；记录 engine / sourceType / weekNo / 步数 / 工具耗时 / token 用量 |

### 静态托管安全（老系统踩过的坑）

老系统的静态服务是**黑名单式**，`serve.js` 落在站点根且 `.js` 在白名单里 → 后端源码被公网直接下载（HTTP 200 / 77,850 B）。

本项目反过来做：**只从 `dist/` 提供服务**，再加 ① 扩展名白名单 ② 显式禁区（`/server` `/seed` `/docs` `/node_modules` `/.git`）③ 隐藏路径拒绝 ④ 路径穿越防护。
实测：`/server/index.ts`、`/seed/snapshot.json`、`/.env`、`/..%2fserver%2fconfig.ts` 全部 403/404，页面与 `dist/assets/*` 正常 200。

---

## 免费获得的两条验收证据

```bash
npm run test:all
```

- `tests/unit.test.ts`：35 条，覆盖日期边界、单双周、`termStart` 缺失、参数校验、来源标记、注入检测
- `tests/acceptance.ts`：33 条，**打真实 SSE 接口**并校验事件顺序、seq 单调、结果结构与周次对齐
- `tests/browser.ts`：32 条，**真的开 Chrome 渲染**，桌面 1440×900 + 手机 390×844，量横向溢出、区块重叠、吸底栏遮挡，并采集 console error

浏览器验收的截图落在 `.screenshots/`（已 gitignore）。

---

## 与老系统的关系

- **只读**：绝不调用老系统写接口，绝不回写
- **独立仓库**：新 Git 历史，不合并旧历史
- **设计令牌**：沿用命名习惯（`--primary` / `--card-bg` 等）与语义色分组，但令牌值是为本产品重新制定的；**没有**整份搬运老系统的 `themes.css`
- 老系统继续跑，它的数据是本项目的"粮草"

---

## 待确认 / 下一步

**待确认（不臆造，逐条给出核实方式）**

| 项 | 状态 | 核实方式 |
|---|---|---|
| Agnes 有效 Key 下的**工具调用**端到端链路 | 未验证。端点可达性与鉴权失败路径已实测（401 `AgnesAI_error`），`stream` / `tools` / `tool_choice` 的请求格式取自官方文档 | 配置有效 `AGNES_API_KEY` 后跑 `npm run test:acceptance`，期望 `run_started.engine === 'agnes'` 且出现 `tool_started` |
| Agnes 流式响应中 `tool_calls` 的分片字段名 | 按 OpenAI 兼容约定实现（`choices[0].delta.tool_calls[].function.arguments` 累积） | 同上；若工具未被调用，先看服务端日志里的原始事件 |
| 学期起止、节次时间是否与实际作息一致 | 取自老系统 `sysConfig` 与 `lib/lab-time.js`，未与教务最新作息核对 | 与教务处课表逐条对比 |

**下一步（按优先级）**

1. 配一个有效 Agnes Key，跑通真实模型工具调用，记录首字延迟与 token 成本
2. 把 `backup.sh` 那套按日归档思路搬过来，给 `state.json` 导出做定时化
3. 补齐"近 7 天同房间排课"这类相邻能力（仍只读），验证工具集扩展的成本
4. 按赛程 W3 闸门要求，把评测集从 33 条扩到 40+ 条并覆盖对抗用例
