# LabOps Agent

**面向高校实验室运维的 AI 原生 Web 应用。** 它不替代学校已有的实验室管理系统，而是通过只读接口接入课程、房间、工单和值班数据，把"查数据、做判断、拟方案"交给 Agent，把"是否执行"留给人。

模型**永远无权**直接提交业务写入：提案参数只存服务端，确认接口白名单校验，前端夹带不进去。未配置模型 Key 时系统诚实降级为规则引擎并明确标注"未调用大模型"，绝不借另一家 Key 冒充，也绝不用演示数据冒充实时数据。

这不是给传统系统加了个聊天框，而是从设计之初就把 **AI 提议 → 人工确认 → 真实执行 → 同编号回查** 作为业务闭环的一等公民。

---

## 30 秒跑起来

需要 Node ≥ 22.18.0（已在 24.x 验证）。**离线演示不需要任何模型 Key、不需要联网、不依赖主系统**：

```bash
npm ci
npm run check:rules
npm run build
npm run demo        # 同时起主系统(18843)与 Agent(18878)，随机账号见启动提示
```

浏览器打开启动提示里的地址即可。演示全程走确定性规则引擎，**零付费模型调用**，结果可复现。

接真实模型：复制 `.env.example` 为 `.env`，填 `AGNES_API_KEY`（工作模式）与 `DASHSCOPE_API_KEY`（聊天模式），再 `npm start`。两把 Key 互不借用——某模式未配 Key 时该模式回落规则引擎并如实标注。

### 上下文预算（确定性截断，可一键关闭）

| 变量 | 默认 | 作用 |
|---|---|---|
| `CONTEXT_TRIM_ENABLED` | `1` | 总开关。设 `0` 时行为与未接入预算前一致，只保留决策可观测（仍显示估算值） |
| `CONTEXT_WINDOW` | `65536` | 所用模型的上下文窗口（**input+output 共享**，所以阈值分母先扣输出预留） |
| `CONTEXT_OUTPUT_RESERVE_TOKENS` | `8192` | 输出预留；有效窗口 = `CONTEXT_WINDOW - min(预留, 窗口)`，永不为负 |
| `CONTEXT_BREAKER_AFTER` | `3` | 连续「精简后仍超阈值」次数上限，达到后置 `circuit_breaker` 并停止再处理 |

阈值 = 有效窗口 × 0.75。token 数是**估算**（中文约 1 字 1 token、拉丁 4 字符 1 token，偏保守），
只用于展示与截断判断，**不冒充** provider 真实 usage。截断只做确定性瘦身：最旧的工具结果全文压到
1200 字并保留摘要；权限作用域、已确认提案的 scopeKey/version、服务端时间基准**永不精简**。

验证方式：改上述变量后重启服务并跑一次多步任务，界面「任务完成」步骤显示
`上下文：估算 X / 阈值 Y token（estimate）· 已精简 N 条工具结果`；调小 `CONTEXT_WINDOW` 应看到
`reason` 由 `below_threshold` 变为 `above_threshold`，设 `CONTEXT_TRIM_ENABLED=0` 应恒为 `disabled`。


## 界面入口

| 入口 | 用途 |
|---|---|
| `index.html` | 桌面 / 公共登录入口 |
| `mobile.html` | 独立移动端入口（PWA manifest + 三套触控手势） |

两者同次构建、同 Cookie。先恢复身份或兑换一次性 SSO，再按手机 / 768px / iPad 规则选择页面。

## 它能做什么

**查询**（只读，18 个工具中的 9 个）：课表、房间档案与动态开放、在室人数、空闲房间、钥匙登记、故障事件、工单状态、通知、定时规则、设备资料。

**办理**（只准备提案，本人确认后才生效）：指定日期调课、检查登记与交接、工单创建与流转、站内通知、临时停用与恢复、资源核实、运营日报、定时规则预览。

**跨端**：桌面与移动同源同构建；另有原生可分发客户端（Windows `.exe` / Android `.apk`），UI 层为 Web 技术，与 Web 端同一套构建产物。

## 架构

```
┌────────────────────────────┐        只读 API + 身份        ┌──────────────────────┐
│  既有实验室管理系统（上游）  │  ◄──────────────────────────► │  LabOps Agent        │
│  非本次作品                 │        委托令牌 AES-256-GCM    │  （本次作品）         │
│  课表 / 房间 / 工单 / 值班   │                               │                      │
└────────────────────────────┘                               │  Agent Runtime       │
                                                              │   有界循环 · 4 终止条件│
  双入口 ──► SSE 流式 ──► 前端结构化卡                          │   领域门控 · 注入留痕  │
   桌面      增量事件      办理单 / 回执 / 轨迹                  │                      │
   移动      seq 去重      人工确认卡                           │  Tools (18)          │
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

## 代码规范与目录结构

- **语言与类型**：TypeScript 严格模式（`vue-tsc` + `tsc` 双工程检查），`npm run typecheck` 是构建门禁；组件 Vue 3 Composition API + `<script setup lang="ts">`。
- **注释纪律**：每个模块文件头有设计说明注释（为什么这么做、取舍与依据、踩过的坑），关键函数带行内注释——可抽查任一源文件核验。
- **提交规范**：Conventional Commits（`feat / fix / docs / test / chore`）+ 中文描述，完整开发历史一条不删（见 Git 记录）。
- **基础约定**：`.editorconfig` 统一字符集 / 换行符 / 缩进底线（项目含刻意紧凑的单行风格文件，故不强制全局重排格式）。

| 目录 | 职责 |
|---|---|
| `web/` | 前端：`App.vue`（PC 壳）、`mobile/`（独立移动端）、`components/`、`stores/`、`composables/`、`preferences/`、`styles/` |
| `server/` | AI 接入层：`agent/`（运行时与提示词）、`llm/`（多模型路由）、`tools/`（白名单工具）、`api/`、`security/`、`persistence/` |
| `shared/` | 前后端共享契约（类型、深链规则、SSE 协议） |
| `tests/` | 单元 / 契约 / 回归 / 浏览器验收脚本 |
| `scripts/` | 评测（检索 / 回答质量 / 自主性）、打包分析、规则同步 |
| `seed/` | 脱敏演示数据与快照生成（含残留自检） |
| `docs/` | 设计与契约文档（`docs/history/` 为已过时阶段设计） |
| `public/` | PWA 离线壳、静态资源 |
| `deploy/` | nginx 部署配置（示例域名占位，部署时替换） |

## 验证与质量

```bash
npm run check:rules     # 镜像一致性 + HTML 资源引用完整性
npm run build           # 含 typecheck
npm test                # 单元 / 契约 / 回归（零 Key、零联网）
npm run eval:retrieval  # 检索：Recall@4 / MRR / 护栏正确率 / 越权泄露
npm run eval:quality    # 回答质量：幻觉率 / 引用准确率 / 越权拦截率
npm run mcp:selftest    # MCP 边界：只暴露只读工具，草稿旁路被挡
```

作品包（交外部前必须过审计）：

```bash
npm run pack:submit -- --out <仓库外目录>
```

打包器会拒绝在有未提交改动时出包，并对**最终产物**独立复核敏感项——`.env`、凭据、数据库、`node_modules` 命中即失败。

**离线**：`mobile.html` / `index.html` 具备 PWA 离线壳（`sw.js` 只缓存外壳与静态资源）。断网可打开已访问过的页面并保留输入；**业务接口与 SSE 一律不缓存**，恢复后按原会话或方案编号回查——不会把过期数据当现状。

## 能力边界（如实声明）

以下**未经验证**，请勿当作已具备能力：真机 iOS/Android 表现、真实付费模型的效果基线、Docker 与生产环境实跑、校园出口容量。系统提示与界面在涉及这些之处均按实际状态标注，不用演示数据冒充实时数据。

## 文档

| 文档 | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 版本沿革 |
| [docs/data-contract.md](docs/data-contract.md) | 数据与执行契约（最硬的一篇） |
| [docs/unified-auth-scheduler.md](docs/unified-auth-scheduler.md) | 统一身份、共享聊天与定时接口 |
| [docs/sync-mobile-contract.md](docs/sync-mobile-contract.md) | 双入口分流与移动契约 |
| [docs/会话分区与轮次操作-开发规划.md](docs/会话分区与轮次操作-开发规划.md) | 轮次行为：需求 → 验收 → 落地差异 |
| [docs/history/](docs/history/) | 已过时的阶段设计，仅供追溯，与实现冲突时以实现为准 |

## 团队信息

**参赛赛事**：全国高校 AI Web 开发挑战赛（传智杯 AI Web 赛道）　**组别**：B组
**参赛学校**：山东师范大学　**参赛队**：你管我对不队

| 成员 | 分工 |
|---|---|
| 熊海诺 | Agent 后端、上线与部署 |
| 王子娴 | 架构选型与搭建、前端 UI 设计与开发、前端界面测试与反馈 |
| 王璟玥 | 前端交互与功能设计与开发、交互功能测试与反馈 |

**指导老师**：高保忠
**联系方式**：熊海诺 ???????????
