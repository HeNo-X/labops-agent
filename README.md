# LabOps Agent

**面向高校实验室运维的 AI 原生 Web 应用。** 它不替代学校已有的实验室管理系统，而是通过只读接口接入课程、房间、工单和值班数据，把"查数据、做判断、拟方案"交给 Agent，把"是否执行"留给人。

模型**永远无权**直接提交业务写入：提案参数只存服务端，确认接口白名单校验，前端夹带不进去。未配置模型 Key 时系统降级为服务端规则引擎，并在回答中明确标注"未调用大模型"，不会用虚构数据冒充实时数据。

这不是给传统系统加了个聊天框，而是从设计之初就把 **AI 提议 → 人工确认 → 真实执行 → 同编号回查** 作为业务闭环的一等公民。

## 界面预览

| 桌面端首屏 | 手机端会话 |
|---|---|
| <img src="assets/screenshots/desktop-hero.png" width="520" alt="桌面端首屏" /> | <img src="assets/screenshots/mobile-conversation.png" width="240" alt="手机端会话" /> |

**提案 → 人工确认 → 写入回执**：

<img src="assets/screenshots/proposal-receipt.png" width="820" alt="提案与回执" />

---

## 快速开始

需要 Node ≥ 22.18.0（已在 24.x 验证）。

```bash
npm ci
cp .env.example .env      # Windows: copy .env.example .env
npm run check:rules
npm run build
npm start
```

浏览器打开 `http://127.0.0.1:8787`。

- **不配置模型 Key**：使用服务端确定性规则引擎，回答中明确标注未调用大模型。
- **不连接上游系统**：使用仓库内的脱敏教学快照（`seed/snapshot.json`）或内置示例数据（`seed/fallback-demo.json`），界面会显示"数据来源"标识。
- **连接上游系统**：在 `.env` 填写 `LABOPS_BUSINESS_URL` 与 `LABOPS_AUTH_MODE=native`，并使用主系统账号登录。
- **沙盒模式**：`LABOPS_AUTH_MODE=demo` 时提供 admin / volunteer / student 三个隔离角色，用于本地体验完整流程。

## 环境配置

完整变量模板见 [`.env.example`](.env.example)。所有变量都有安全默认值，常用的几项：

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 监听端口与地址 |
| `LABOPS_BUSINESS_URL` | 空 | 上游实验室系统根地址；留空则只用本地数据 |
| `LABOPS_AUTH_MODE` | `native` | `native` 复用上游账号；`demo` 使用隔离沙盒 |
| `LABOPS_DB_PATH` | `server/data/labops.sqlite` | 会话、提案、幂等记录的持久化位置 |
| `AGNES_API_KEY` | 空 | 工作模式模型 Key；留空则使用规则引擎 |
| `DASHSCOPE_API_KEY` | 空 | 聊天模式模型 Key；留空则使用规则引擎 |
| `LABOPS_SERVICE_SECRET` | 空 | 上游定时任务调用本服务的共享密钥 |
| `LABOPS_SECURE_COOKIE` | `0` | HTTPS 部署时设为 `1` |

**依赖清单**：

- 运行时：Node.js ≥ 22.18（使用原生 TypeScript type stripping，无需 tsx/ts-node）。
- 生产依赖：`vue`、`pinia`、`@vue/devtools-api`。
- 开发依赖：`vite`、`typescript`、`vue-tsc`、`@vitejs/plugin-vue`、`@types/node`、`playwright-core`。
- 精确版本与完整传递依赖见 [`package.json`](package.json) 与 [`package-lock.json`](package-lock.json)。

## 它能做什么

**查询**（只读）：课表、房间档案与动态开放、在室人数、空闲房间、钥匙登记、故障事件、工单状态、通知、定时规则、设备资料、签到明细、开放实验室记录、人员目录、视觉巡检结论。

**办理**（只准备提案，本人确认后才生效）：指定日期调课、检查登记与交接、工单创建与流转、站内通知、临时停用与恢复、资源核实、运营日报、定时规则预览、钥匙借还。

**跨端**：桌面与移动同源同构建；另有原生可分发客户端（Windows `.exe` / Android `.apk`），UI 层为 Web 技术，与 Web 端同一套构建产物。

## 架构

```
┌────────────────────────────┐        只读 API + 身份        ┌──────────────────────┐
│  既有实验室管理系统（上游）  │  ◄──────────────────────────► │  LabOps Agent        │
│  课表 / 房间 / 工单 / 值班   │        委托令牌 AES-256-GCM    │  （本仓库）           │
└────────────────────────────┘                               │                      │
                                                              │  Agent Runtime       │
  双入口 ──► SSE 流式 ──► 前端结构化卡                          │   有界循环 · 4 终止条件│
   桌面      增量事件      办理单 / 回执 / 轨迹                  │   领域门控 · 注入留痕  │
   移动      seq 去重      人工确认卡                           │                      │
                                                              │  Tools (18)          │
                                                              │   9 只读 · 9 草稿     │
                                                              │   白名单按模式+角色门控│
                                                              │                      │
                                                              │  RAG  权限感知检索    │
                                                              │  多模态 视觉初判      │
                                                              │  MCP  对外只读暴露    │
                                                              │                      │
                                                              │  SQLite 会话/提案/幂等│
                                                              └──────────────────────┘
```

**关键设计**：`prepare_*` 工具只把提案落到服务端，返回给模型的视图不含可执行参数；确认接口 body 仅允许 `proposalId / version / decision / clientRequestId` 四个字段。因此即使模型被说服，也无法构造出一次越权提交。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 Composition API、`<script setup lang="ts">`、Pinia、Vite |
| 服务端 | Node.js 原生 TypeScript、HTTP/SSE、SQLite（`node:sqlite`） |
| 模型接入 | Agnes、DashScope、BigModel、讯飞星火；统一路由、熔断与诚实降级 |
| 契约 | 前后端共享类型与 SSE 协议（`shared/`）；HTML 镜像一致性检查 |
| 质量 | `node:test` 单元/契约/回归测试、检索与回答质量评测、MCP 边界自检 |

## 代码规范与目录结构

- **语言与类型**：TypeScript 严格模式（`vue-tsc` + `tsc` 双工程检查），`npm run typecheck` 是构建门禁；组件使用 Vue 3 Composition API。
- **静态检查**：ESLint 基线配置（`eslint.config.mjs`），`npm run lint` 检查语法错误与常见危险模式（重复键、不可达代码、NaN 比较等），不引入风格类告警。
- **注释纪律**：模块文件头说明设计依据、约束与取舍；关键函数带行内注释，只解释不显而易见的逻辑。
- **提交规范**：Conventional Commits（`feat / fix / docs / test / chore`）+ 中文描述。
- **基础约定**：`.editorconfig` 统一字符集、换行符与缩进底线；项目含刻意紧凑的单行风格文件，因此不强制全局重排格式。

| 目录 | 职责 |
|---|---|
| `web/` | 前端：`App.vue`（PC 壳）、`mobile/`（独立移动端）、`components/`、`stores/`、`composables/`、`preferences/`、`styles/` |
| `server/` | Agent 接入层：`agent/`（运行时与提示词）、`llm/`（多模型路由）、`tools/`（白名单工具）、`api/`、`security/`、`persistence/` |
| `shared/` | 前后端共享契约（类型、深链规则、SSE 协议） |
| `tests/` | 单元 / 契约 / 回归测试 |
| `scripts/` | 评测、打包分析、规则同步、环境自检 |
| `seed/` | 脱敏教学快照与内置示例数据 |
| `public/` | PWA 离线壳、静态资源 |
| `vendor/pages/` | 契约镜像的仓内快照（独立 clone 时供 `npm run check:rules` 使用） |
| `deploy/` | nginx 部署配置示例 |

## 验证与质量

```bash
npm run typecheck       # vue-tsc + tsc 双工程检查
npm run lint            # ESLint 基线检查
npm run check:rules     # 镜像一致性 + HTML 资源引用完整性
npm run build           # 类型检查 + 生产构建
npm test                # 单元 / 契约 / 回归（666 项，零 Key、零联网）
npm run mcp:selftest    # MCP 边界：只暴露只读工具，草稿旁路被挡
npm run eval:retrieval  # 检索：Recall@4 / MRR / 护栏正确率 / 越权泄露
npm run eval:quality    # 回答质量：幻觉率 / 引用准确率 / 越权拦截率
```

**离线壳**：`mobile.html` / `index.html` 具备 PWA 离线壳（`sw.js` 只缓存外壳与静态资源）。断网可打开已访问过的页面并保留输入；**业务接口与 SSE 一律不缓存**，恢复后按原会话或方案编号回查，不会把过期数据当现状。

## 能力边界（如实声明）

以下**未经验证**，请勿当作已具备能力：真机 iOS/Android 表现、真实付费模型的效果基线、Docker 与生产环境实跑、校园出口容量。系统提示与界面在涉及这些之处均按实际状态标注。

本仓库是 Agent 组件；上游实验室管理系统独立部署，通过只读 API 接入。仓库内的测试覆盖 Agent 自身的逻辑与契约；涉及上游系统的联调用例不在本仓库内。

## 团队信息

**参赛赛事**：全国高校 AI Web 开发挑战赛（传智杯 AI Web 赛道）　**组别**：B组
**参赛学校**：山东师范大学　**参赛队**：你管我对不队

| 成员 | 分工 |
|---|---|
| 熊海诺 | Agent 后端、上线与部署 |
| 王子娴 | 架构选型与搭建、前端 UI 设计与开发、前端界面测试与反馈 |
| 王璟玥 | 前端交互与功能设计与开发、交互功能测试与反馈 |

**指导老师**：高保忠
