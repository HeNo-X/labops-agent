# LabOps Agent · 实验室任务助手

> 用一句话交办实验室任务，Agent 查证后给结论、需要办理的给办理单。当前状态（阶段 2B 首片）：
> **一句话输入 → 任务流可视化（指令 → 工具 → 结论）→ 3 个只读工具（课表 / 房间状态 / 空闲房间）→ 结构化结果 + 数据来源标识 → 会话承接（"那 E312 呢？"）→ 业务办理（报修 / 临时停用 / 站内通知 / 值班收尾 / 运营日报）→ 提案卡一次确认 → 沙盒执行 → 业务单号与回执**。

来源项目：本校在用的实验室管理系统（真实场景、真实数据、已公网部署）。
本仓库是**全新独立仓库**，不合并老系统的 Git 历史（老历史含旧版凭据）。

---

## 快速开始

```bash
# 环境要求：Node >= 22.18（用到原生 TypeScript 类型剥离，不依赖 tsx/esbuild）
node -v

npm install
cp .env.example .env          # 可选。留空 AGNES_API_KEY 即为演示引擎模式
```

### 方式 0 · 双击启动（完全不用碰终端）

直接双击项目根目录的 **`start.cmd`**。它会依次：

1. 检查环境（Node 版本 / 依赖 / 前端产物 / 数据源 / 引擎 / 端口占用）
2. 缺依赖就 `npm install`，缺产物就 `npm run build`（首次会慢一点）
3. 起服务端，**3 秒后自动打开浏览器**到 <http://127.0.0.1:8787>
4. **关掉那个黑窗口 = 停止服务**

想放桌面：右键 `start.cmd` → 显示更多选项 → 发送到 → 桌面快捷方式（可以重命名成「LabOps Agent」）。

> 只做检查不启动：`node scripts/check-env.mjs`
> 只检查不自动开浏览器：设环境变量 `LABOPS_NO_BROWSER=1`

### 方式 A · 开发模式（写代码时用）

```bash
npm run dev
```

- **访问地址：<http://127.0.0.1:5173>**
- 同时起两个进程：服务端（8787，`node --watch` 改代码自动重启）+ Vite（5173，热更新）
- Vite 已把 `/api` 代理到 8787，**只开 5173 一个地址就够了**，不用去点 8787
- 按 `Ctrl+C` 一次，两个进程一起收工（自研并发脚本会转发信号，不留孤儿进程）

### 方式 B · 生产模式（单进程，最接近交付形态）

```bash
npm run build     # vue-tsc 类型检查 + vite build → dist/
npm start         # node server/index.ts：同时托管 dist/ 与 API
```

- **访问地址：<http://127.0.0.1:8787>**
- 只有一个进程、一个端口，前端产物 gzip 后 38.5 kB
- 首屏更快（无 Vite 的模块请求开销），适合录演示视频

### 访问不到时的排查顺序

| 现象 | 原因 | 处理 |
|---|---|---|
| 连接被拒绝 / `ERR_CONNECTION_REFUSED` | 服务端没起或已退出 | 看终端有没有报错；重跑 `npm run dev` |
| 端口被占用（`EADDRINUSE`） | 8787 / 5173 已被别的进程占用 | 换端口：`PORT=8799 npm run dev`；或查占用 `netstat -ano \| grep :8787` |
| 页面能开但没有结果、一直转圈 | 服务端没起，Vite 代理打不通 | 直接看 8787 能否打开 —— 打不开就是服务端的问题 |
| Node 报 `Unknown file extension ".ts"` | Node 版本低于 22.18 | 升级 Node（本项目刻意不用 tsx/esbuild） |

### 想在手机上打开？

默认只监听 `127.0.0.1`（**有意为之**：这个 API 会把请求转发给 Agnes，配上 Key 后监听全网就等于把 Key 的消费能力开放给局域网）。要测移动端布局时临时开放：

```bash
# 1) 查本机内网 IP（Windows）
ipconfig | findstr IPv4

# 2) 临时开放监听，然后用手机访问 http://<内网IP>:8787
HOST=0.0.0.0 npm run build && HOST=0.0.0.0 npm start

# 3) 用完改回默认（或直接 Ctrl+C）
```

> 手机与电脑要在同一个 WiFi 下。Windows 防火墙可能会弹窗询问是否允许 Node 访问网络，需要点允许。

### 常用脚本

| 命令 | 作用 |
|---|---|
| `start.cmd`（双击） | 一键启动：自检 → 装依赖 → 构建 → 起服务 → 开浏览器 |
| `node scripts/check-env.mjs` | 只做环境自检，不启动（退出码 1 = 有阻塞项） |
| `npm run dev` | 服务端 + 前端一起起（零依赖自研并发脚本） |
| `npm run dev:server` | 只起服务端（`node --watch`） |
| `npm run dev:web` | 只起 Vite |
| `npm run build` | 类型检查 + 前端构建 |
| `npm start` | 生产启动（API + 静态托管） |
| `npm run typecheck` | 前后端全量类型检查 |
| `npm run seed -- <state.json>` | 从真实数据生成脱敏快照 |
| `npm test` | 单元测试（45 条） |
| `npm run test:acceptance` | 端到端验收（打真实 SSE 接口，50 项，含会话持久化闭环） |
| `npm run test:browser` | 真实浏览器验收（桌面 + 手机，45 项，含 P0 竞态与历史恢复用例） |
| `npm run test:all` | 上面三套全跑 |

---

## 当前运行状态（2026-09-26 第二轮实测后）

| 项 | 值 |
|---|---|
| 推理引擎 | **演示引擎**（未配置 `AGNES_API_KEY`）—— 服务端规则解析，未调用大模型 |
| 数据来源 | **脱敏快照**（`seed/snapshot.json`） |
| 数据规模 | 实验室 10 + 开放实验室 6 / 课表 **139** 条 / 学期 `2026-2027-1`，起始日 `2026-09-07` |
| 已注册工具 | **3 个**（全部只读）：`query_schedule` / `query_lab_status` / `query_free_rooms` |
| 会话能力 | **持久化会话工作台**（node:sqlite）：左侧导航最近会话、连续消息流、刷新/重启后历史恢复、`clientRequestId` 幂等提交；`sessionId` 承接上一问的房间号与日期（非法实体不入上下文） |
| 测试 | 单元 45/45 ｜ 端到端 53/53 ｜ 浏览器 46/46 |

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
| `HOST` | `127.0.0.1` | 监听地址。**默认只允许本机访问**（见上文"想在手机上打开"） |
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
├── start.cmd                   ★ 双击启动（纯 ASCII + CRLF，避免 console 码页乱码）
├── index.html                  Vite 入口
├── scripts/
│   ├── check-env.mjs           环境自检（Node 版本/依赖/产物/数据源/引擎/端口）
│   └── dev.mjs                 开发模式并发启动（零依赖自研）
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
├── web/                        Agent 工作台（Vue 3 + Pinia + TS）
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

## 业务沙盒（2026-09-27 第五轮，阶段 2B）

按《LabOps-Agent-实验室实操功能设计与下一阶段开发任务书》（GPT 生成、P0+P1 批次）交付"模型准备、服务端提交"的业务办理链路：

- **ops.v1 契约**：`shared/operations-contract.ts`（Task / Proposal / Decision / OperationReceipt + `need_confirm` / `task_updated` / `operation_result` 事件）；`ToolResultKind` 扩展 `operation_proposal` / `operations_report`。
- **持久化**：`ops_tasks` / `ops_proposals` / `ops_decisions` / `ops_operations` / `ops_audit` / `ops_outbox` + 沙盒业务表 `biz_issues` / `biz_notifications` / `biz_closures` / `biz_duty_sessions`（幂等键唯一索引、提案 TTL 30 分钟、惰性过期）。
- **5 个准备类工具**（`server/tools/prepare-tools.ts`，effect=draft，只生成办理单不执行）：
  `prepare_issue_ticket`（F01 报修）、`prepare_room_closure`（F02 停用，服务端按教学周口径计算受影响排课，可联动建单+通知）、`prepare_notification`（F03 站内通知，班级受众按课表数据校验）、`prepare_duty_session`（F06 值班开始/收尾交接，清单按用户陈述预填、未提到的一律"未确认"）、`create_operations_report`（F10 日报草稿，缺数据源指标如实标"未知"而非 0）。
- **执行通道**：`POST /api/tasks/:id/decisions` 是唯一执行入口（模型无权调用）。请求只允许 `proposalId + proposalVersion + decision + clientRequestId`，业务参数从服务端持久化提案读取（T04）；幂等键重放返回原回执（T05）；版本错配/过期/已决定/越权分别返回结构化错误；执行走 `server/operations/gateway.ts`，复合操作单事务全成全败，逐对象审计 + outbox 投递记录。
- **身份与能力**：沙盒演示身份（admin / volunteer / student，`LABOPS_SANDBOX_ROLE` 配默认，前端可切换演示视角），能力清单 `issue:create:self` / `notice:publish` / `availability:write` / `duty:write` / `report:create:self` 按角色收敛，学生确认发布通知返回 403（T02）。**production 环境未接入**：回执 `executionEnvironment` 恒为 sandbox，界面全程标注"沙盒演示"。
- **界面**：消息内嵌**提案卡**（影响预览 + 一次确认 + 业务回执，历史卡自动向服务端核对状态——已执行显示回执、过期不可确认，T11）+ **日报卡**（缺失指标标未知）+ 左侧**我的任务**中心 + 沙盒身份切换。
- **与任务书的偏离**（按项目现状）：无真实登录体系 → 沙盒演示身份代替身份委托；`roomId` 采用数据集房间号；值班无排班实体 → start 按房间建会话、handover 由用户逐项确认清单；附件仅登记引用（上传服务未接入）。
- **测试**：`npm test` 含 `tests/operations.test.ts`（提案→决策→回执、幂等、越权、版本错配、过期、复合停用、值班闭环、日报口径）；浏览器验收 46/46、HTTP 验收 53/53 保持全过。

## 工作台外观与聊天模式（2026-09-27 第六轮）

按用户实测反馈完成的四项改造：

- **全宽布局**：去掉 1760px 最大宽度与两侧大留白，中间对话区拿到全部剩余空间。
- **输入框固定视口底部**：会话视图列高锁定视口（`.chat--conv`），消息区内部滚动，composer 不再随内容下移；空会话保持居中 hero 形态不变。
- **房间清单改为停靠式侧边栏**：右侧常驻，可收起为 44px 窄轨（竖排"房间清单"标签 + « 展开钮），不再用"整体移除 + 独立展开按钮"；窄屏收起时正文右侧让位、展开时为抽屉。
- **会话分「聊天 / 任务」两种**：会话携带 `mode` 字段（conversations 表，PATCH 可切换，服务端为权威）。聊天模式**无任何工具**——不能查询数据、不能执行任务操作，Agnes 提示词切换为自由对话版（PROMPT_VERSION 升至 v2.1.0）；演示引擎下诚实说明"聊天需接入大模型"。hero 建会话时先选模式；头部可随时切换；左侧会话列表带「聊」标。任务模式行为不变。

实现备注：Vue 的 Boolean prop 未传时会被置为 `false` 而非 undefined——`CommandBar` 的 `examples` 等可选布尔 prop 必须用 `withDefaults` 给默认值，否则"不传=显示"的语义失效（本轮实测踩坑）。

## 阶段 2A 能力边界


> 阶段 2B（业务沙盒）已在上节交付：报修 / 临时停用 / 站内通知 / 值班收尾 / 运营日报可在**沙盒**内办理（提案卡确认 → 业务单号与回执）。下表"零写操作"的表述仅针对 2A；2B 起写操作边界 = 提案卡确认 + 服务端能力校验 + 沙盒执行。

**能做**（3 个只读工具 + 5 个准备类工具）：
- 查某房间某天的排课（含合班、单双周、节次过滤、假期、停课），给出数据来源与依据
- 查房间档案与状态：位置、容量、开放状态、当日排课概况、下一节课（`query_lab_status`）
- 找某天（某节次）没排课的房间（`query_free_rooms`）—— 注意"空闲"= 课表无排课，不代表室内无人
- 会话承接：同 sessionId 内「那 E312 呢？」沿用上一问的日期（沿用会在回答里说明，不伪装成本轮识别）

**不能做（明确说了"做不到"而不是编一个答案）**：

- 签到人数 / 在室人数（没有数据来源；`query_lab_status.occupancy` 恒为 `null`）
- 钥匙位置、签到办理、排班换班、课表导入调课、用房预约、积分核对、人员导入（F04/F05/F07/F08/F09/F11/F12 排后；未注册工具，界面不提供入口）
- 知识库问答（RAG 未接入）
- 真实业务写入（production 适配器未接入；沙盒办理全程标注"沙盒演示"，回执 `executionEnvironment=sandbox`）
- 历史统计（数据只覆盖当前学期）
- `query_schedule` 的日期范围 / 班级筛选（下一批，等数据契约扩充）

---

## 可靠会话（2026-09-27 第四轮，阶段 2A.3）

按《LabOps-Agent-压缩包4复核与下一阶段开发提示词》完成 M0 + M1 核心 + M2 快赢（N01–N13/N15/N17–N21/N23）：

- **崩溃与事务（N01/N02/N04）**：会话路由可 await、统一异常边界；runId 由服务端生成；user/assistant/run 三件套**单事务创建**（失败整组回滚，绝不半写入）；同会话并发 run 互斥（事务预检 + 部分唯一索引，冲突返回 409+活跃 runId）；终态**先落库成功再发权威 end**，落库失败发 save_failed 明示；增量刷写 32 条或 1.5 秒取先到。
- **幂等（N17）**：clientRequestId 唯一索引 + 预检，重复返回 409 引用既有执行。
- **结果归属（N03）**：TaskResult 改纯 props 渲染器，**每条助手消息拥有自己的结构化结果卡**（来自 toolCalls[].result），切会话/刷新/重启后正文+卡片+来源完整恢复，不再读取全局单例。
- **失败与取消（N05/N06）**：run_failed 的错误码/说明落库（meta.error），失败消息带"重新执行上一问"按钮；新增 `POST /api/runs/:id/cancel` 显式取消接口（幂等），服务端终态记 cancelled —— 与断连的 interrupted 诚实区分；**取消压过完成**（abort 后不再补发 run_completed，验收实测 cancelled 而非 completed）。
- **上下文持久化（N07/N08）**：ContextSnapshot 落库（conversations.contextLab/Date/Task），服务重启后"那 E312 呢"仍承接日期与任务类型；"现在/此刻"显式解析为服务端当天，覆盖继承的未来日期；追问按字段继承任务类型，不再整包跳回课表。
- **覆盖与未知（N09/N10-lite）**：空课表/超学期范围（教学周>40）/教学周不可确定 → coverage=missing/out_of_range/unknown，`freeByPeriod.rooms` 一律为空，候选进 unknownCandidates（界面标注"未知"，绝不当空闲推荐）。
- **参数校验（N11）**：coerce 移入工具受控边界，显式非法（错误类型/非法枚举/数组类型错）返回结构化 ok=false，不再静默放宽为全天。
- **可用性（N15/N18/N20/N21/N23）**：会话缓存始终后台重新核对（请求代次防串）；手机空态有"会话"入口；会话改名（✎）与删除确认；草稿按会话保存；正文浅灰对比度提至 ≥4.5:1；Esc 关抽屉。
- **本轮未做（按任务书排后）**：N10 完整学期日历、N12/N16 多房间比较与分页、N14 真实模型多轮与 deadline、N22 Markdown、N25 数据质量报告、N27 完整迁移体系、N28 认证层、N29–N32。

## 会话工作台（2026-09-27 第三轮，阶段 2A.2）

按《LabOps-Agent-新版深度审查与会话工作台开发提示词》完成 M0+M1+M2 核心：

- **持久化**：`server/persistence/db.ts`（node:sqlite，零依赖）。Conversation/Message/Run 落库（ToolCall 嵌入 message.meta）；`clientRequestId` 唯一索引幂等（重复返回 409，重试恢复协议待完成）；服务重启在**建唯一索引之前**把遗留 running/streaming/save_failed 标为 interrupted（旧库多条 running 也能安全升级）；会话软删除（暂无恢复入口）。数据库文件 `server/data/labops.sqlite`（已 gitignore，可用 `LABOPS_DB_PATH` 隔离测试）。
- **API**：`GET/POST /api/conversations`、`GET/PATCH/DELETE /api/conversations/:id`、`POST /api/conversations/:id/messages`（SSE：`run_accepted` 携带正式消息 ID → 引擎事件 → **终态事务成功后**发权威 `run_completed` → `end`（payload.saved 标记保存结果，失败另有 `save_failed` 事件）；运行中消息按 32 条或 1.5 秒（另有 700ms 定时兜底）增量落库）；`GET/POST /api/runs/:id/cancel` 显式取消（已终态返回既有状态）；旧 `POST /api/agent/chat` 保留（验收脚本兼容）。
- **界面**：左侧导航（新聊天 / 最近会话 / 主题与来源徽章）+ 右侧可展开/收起的实验室房间面板+ 中央连续消息流 + 布局内 composer（不悬浮遮挡）；房间点击只回填草稿；发送后清空草稿；每条助手消息带工具卡（参数可查）、复制按钮与终态标签。
- **正确性修复（2A.4 增补）**：前端消费 `end.saved` 与 `save_failed`（保存失败可见、状态转 failed、可重试）；run_completed 权威全文对齐流式正文；`run_accepted` 对齐正式消息 ID（按 ID 解析活跃消息，历史刷新不跟丢）；取消先等服务端确认再断流（cancelled/interrupted 可区分）；`task`/`lastTask` 字段统一（追问保持任务类型）；空闲覆盖以 `termEnd` 数据契约为准（缺失 → unknown + unknownCandidates，卡片不写"无空闲房间"）；数字/数组类型的工具参数显式报错。
- **已知边界（下一批）**：F14–F16（真实模型多轮上下文/比较任务）、F20–F22、F24–F26 深化、F31 Markdown 渲染、F37–F40（deadline/finishReason/SSE 严校验）、F41 认证层。

## 工作台改造记录（2026-09-26 第二轮）

本轮在运行页面上实测后完成的改造（详见《LabOps-Agent-工作台改造与阶段2A开发提示词》）：

| 类别 | 内容 |
|---|---|
| **P0 竞态修复** | 运行生命周期（`runStatus`）与结果类型（`resultKind`）拆分；只有终态事件 + 流收尾才解锁输入；浏览器用例固化（工具结果已到、回答未结束时无法二次提交） |
| **任务隔离** | 前端为每次任务生成 `runId` 随请求发送，store 丢弃一切不匹配的事件 —— 旧流迟到事件不可能污染新任务 |
| **toolCallId 进契约** | `tool_started/tool_result` 按 `toolCallId` 一一配对（Agnes 用模型 call.id，演示引擎生成 `tc{step}_{i}`） |
| **重复检测前置** | 指纹 = 工具名 + 排序参数，**执行前**检查；命中即拦截（`duplicate_call_blocked`），不重复执行；删除死代码 `fp` |
| **时间线单一终态** | 终态事件关闭"正在生成回答"步骤；不再出现"进行中"与"任务完成"并存 |
| **取消贯穿** | AbortSignal 传入 Agent 循环与模型请求；前端把取消呈现为中性"任务已取消"（不是红色故障），输入立即解锁 |
| **数据缓存失效** | `loadDataset()` 按源文件 mtime 失效重建 —— 实时模式下底层文件更新后能拿到新数据 |
| **布局重排** | 空态 hero（大输入 + 示例点击即发起 + 能力一句话）；任务卡 = 指令 → 轨迹（短摘要+可展开明细）→ 结论 → 结构化结果卡 → 折叠的数据依据；房间清单瘦身为侧栏可搜索紧凑行；移除常驻占位确认卡；开发备注移出产品界面 |
| **阶段 2A 首片** | sessionId 会话承接 + `query_lab_status` + `query_free_rooms`（注册表 = 真实能力清单，无数据的工具继续不注册） |

---

## 健壮性设计（对应硬约束）

| 约束 | 落地位置 | 具体做法 |
|---|---|---|
| **有界自主** | `agent/run.ts` | 四个停止条件：`max_steps`(6) / 墙钟(60s) / 无工具调用 / 重复调用检测（同工具+同参数 2 次即**在执行前**拦截）。绝无 `while(true)` |
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
