# CortxtOS v2 · 个人 AI 工作台 — 设计文档

**版本** v2.2 · 2026-09-19 · 增补下一版范围（grilling 第三轮）：① 对话工具深挖 = **混合式**（固定首检索打底 + 模型按需调 kb_search/kb_read/kb_list）；② 图片问答 = vision 档当轮对话，**不入库**；③ 快速捕获 = 纯文本/Markdown，首行作标题；④ 自定义任务可勾选"携带知识库检索"；⑤ 模型阵容保持只读（v2.1 裁定不变）；⑥ 部署 = update.sh 一键更新。

---

## 0. 如何读本文档

- 本文是唯一权威需求来源。所有产品决策已锁定，实现阶段不再重议。
- 术语以 §12 词汇表与 CONTEXT.md 为准（含禁用语清单），重大取舍见 docs/adr/0001–0004，non-goals 见 §11。实现中与本文冲突时，以本文为准（或先改本文）。
- 部署时需要用户提供的 3 项外部输入见 §9.5。

## 1. 一句话定位

**CortxtOS v2 = 自托管的个人 AI 工作台**：跑在用户自己的腾讯云服务器上、单用户、数据 100% 自有的二次元风格 Web 应用。核心能力 = 深度知识库问答（主轴）+ 自动化简报（副轴）+ 多模型路由（支撑层）。

> 术语约定：原需求书中的"本地优先（Local-First）"在 v2 中改写为**"自托管私有部署"**——其对立面是第三方 SaaS，而不是云服务器。原文案"将你的个人计算机升级为大脑皮层操作系统"相应变为"**把大脑皮层安在你自己的服务器上**"。

## 2. 用户与场景

| # | 场景 | 频率 | 支撑模块 |
|---|------|------|----------|
| S1 | 扔进一批文档（笔记/PDF），随时提问，回答必须给出处 | 每天 N 次 | 知识库 + 对话（主轴） |
| S2 | 每天定时生成 briefing（知识库日报：昨日新增/变更文档摘要），打开页面即读 | 每天 1 次 | 自动化（副轴） |
| S3 | 简单任务交给便宜模型跑（摘要、起标题），贵模型只伺候主对话 | 每天 | 模型路由 |
| S4 | 偶尔看一眼这个月花了多少 token、哪家模型用得多 | 每周 | 用量记账 |

用户画像：极客/专业开发者（就是用户本人），Windows PC 为主要访问终端（浏览器），接受移动浏览器顺带可读，但**不做**任何移动专属优化承诺。

## 3. 信息架构（Web 页面）

登录页 → 单页应用，左侧边栏 + 主内容区：

| 页面 | 里程碑 | 内容 |
|------|--------|------|
| **对话**（默认首页） | M0 | 多会话列表、流式回答、引用卡片（点击跳源文档段落）、模型标识 |
| **知识库** | M0 | 文档列表（状态：待索引/索引中/就绪/失败）、拖拽上传、在线 Markdown 编辑器、删除/重建索引 |
| **简报** | M0 | 每日 briefing 列表 + 详情 |
| **任务** | M1 | 定时任务列表（开关/下一步运行时间）、运行记录（输入/输出/耗时/状态） |
| **用量** | M2 | 按模型/按用途（chat/bg/embed）的 token 与费用估算，日/月聚合 |
| **设置** | M0/M2 | M0：修改密码 + 模型阵容**只读**展示（key 只在服务器 `.env`，永不回显）；M2：阵容可编辑 + 手动换档 |

## 4. 模块规格

### 4.1 知识库（主轴，痛点②的正解）

**入库管线**：上传（拖拽/选择，MVP 支持 `.md` `.txt` `.pdf`）→ 抽文本（md/txt 直读；PDF 用 Node 侧解析库，**保留页码**）→ 分块（标题层级感知，目标 ~500 token，重叠 ~15%，chunk 记录 `document_id + 页码/标题路径`）→ 嵌入（API：聚合平台 OpenAI 兼容 `/v1/embeddings`，默认 BGE-M3 系）→ 写入 sqlite-vec + FTS5（中文分词见 ADR 0004）。文档身份 = 内容哈希（sha256），重复上传幂等；上传文件即写入 Vault（真相源），单文件上限 50MB；删除文档 = 删文件 + 删索引行，原子完成。

**检索管线**：查询 → 向量 topK20 + FTS5 关键词 topK20 → RRF 融合 → top6 注入 prompt，编号引用。回答流式输出，**每条事实性回答必须携带引用**（文档名 + 页码/段落锚点），引用可点击：M0 = 打开内置查看器（Markdown 渲染预览；PDF 浏览器原生预览并跳 `#page=N`）；段落级高亮定位归 M3。

**在线编辑**：M0 提供极简 Markdown 编辑器（保存即重新入库该文档）。

### 4.2 对话

- 多会话（SQLite 持久化），流式（SSE），停止按钮即断开释放。
- **检索形态 = 两段式**（grill-with-docs 裁定）：M0 为**固定管线**——每条消息自动走 §4.1 检索并注入 top6，不绕 agent loop（快、便宜、行为可预期）；M1 起引入工具深挖：模型可按需调用 `kb_search`（补检索）、`kb_read`（读指定文档全文/指定页）、`kb_list`（文档清单），工具就这三个，克制。
- 聊天**固定走 `primary` 档，不自动降级**（质量可预期 > 省钱）；任何档位失败都**显式报错**并给出手动换档按钮，绝不静默换模型。
- 上下文窗口 = 最近 12 轮 + 本次检索结果，超出截断。

### 4.3 自动化（副轴）

- 定时任务：服务器 cron 语义（分钟粒度），M0 内置一个 `daily-briefing`（默认每日 08:00，可在设置页改）。
- briefing 生成 = 对"过去 24h 新增/变更文档"做摘要 + 可配置提示词模板，走 `background` 档，产物落简报页。
- 运行记录全量落库（状态/起止/输出/报错），页面可查。
- 手动技能（M1）：页面上点按钮立即执行的任务。

### 4.4 模型路由

- BYOK：供应商 = 聚合平台（OpenAI 兼容端点），key 只存服务器 `.env`，永不入库、永不下发前端。
- ModelProfile 四角色（`config.json` 可改）：`primary` = `deepseek-v4-pro-0813`、`vision` = `qwen3.8-flash`、`background` = `deepseek-v4-flash-0731`、`embedding` = BGE-M3 系。**全文禁用"兜底/fallback"**——background 的职责是后台杂活，不是接盘 chat。
- 分流规则（确定性，无打分仲裁）：`chat → primary`；后台杂活（Briefing/摘要/标题）→ `background`；嵌入 → `embedding`；M2 起 `vision` 接入图片问答并支持手动换档。
- 每次调用强制落 UsageRecord；`cost_est` 按 config 可选单价表估算，未配单价只记 token 不折算钱。

## 5. 技术架构

```
浏览器 (Vue 3 SPA)
   │  HTTPS
Caddy (自动 TLS, 反代)
   │
Node 22 单进程 daemon (TypeScript ESM)
 ├─ HTTP/SSE API + 静态托管前端产物
 ├─ 认证（单用户密码, argon2, HttpOnly Secure Cookie 会话）
 ├─ Pi 集成：@earendil-works/pi-agent-core (agent loop + tools)
 │           @earendil-works/pi-ai (统一 LLM API → 聚合平台)
 ├─ 检索：better-sqlite3 (WAL) + FTS5 + sqlite-vec
 ├─ 调度器：进程内 cron
 └─ /data 卷：SQLite 库 + 原始文档 + 生成物
```

- **不 fork Pi**，npm 依赖 + lockfile 固定版本；`models.json` 由 `config.json` 派生。
- 前端：**Vue 3 + Vite + Tailwind CSS**（沿用用户博客技术栈，维护心智一致）；pnpm **单包**（前后端 `src/server` `src/web` 分层），不拆 monorepo。
- 配置：`/data/config.json`（模型阵容等）+ `.env`（`APP_PASSWORD`、`LLM_API_KEY`、`LLM_BASE_URL`）。
- 中文 UI。

## 6. 数据模型（SQLite 核心表）

`documents`(id, title, source, mime, sha256, size, status, created_at, updated_at) ·
`chunks`(id, document_id, ord, text, page, heading_path, token_count) ·
`chunks_fts`(FTS5) · `chunk_vec`(sqlite-vec) ·
`sessions`(id, title, created_at) · `messages`(id, session_id, role, content, citations JSON, model, usage, created_at) ·
`jobs`(id, kind[cron|manual], spec, enabled, last_run_at) · `runs`(id, job_id, status, started_at, finished_at, output, error) ·
`usage_records`(id, model, purpose[chat|bg|embed], prompt_tokens, completion_tokens, cost_est, created_at) **——每次 LLM/嵌入调用强制落一条** ·
`kv`(杂项)

## 7. 二次元设计系统

- 基调：**深色霓虹**——深色工作台底子（近黑的蓝紫深底）+ 粉紫霓虹点缀 + 细节二次元元素（点缀性立绘/装饰、动漫感圆角与描边、状态用角色化微动效文案）。
- 产出方式：M0 期间由视觉模型出 1 版简单样式稿（主色板 + 关键组件观感），据此实现 CSS 主题；不做 Live2D、不做常驻看板娘、不做语音（v2 永久 non-goal）。

## 8. 安全边界

- 公网暴露面 = 443 (Caddy) 一切走 HTTPS；登录限速（防爆破）。
- 单用户密码：首次启动从 `.env` 的 `APP_PASSWORD` 种子，argon2id 哈希入 DB，**此后以 DB 为准**（`.env` 仅在库中无密码时生效）；设置页改密写 DB。会话 Cookie HttpOnly + Secure。
- egress 白名单：只调用聚合平台 LLM/嵌入端点；v2 无其他外呼（无邮件、无第三方推送）。
- API key 只存服务器 `.env`；日志与 usage_records 不落 key。

## 9. 部署与运维

### 9.1 目标机
腾讯云轻量 `106.55.102.231`，CentOS Stream 9，全新系统。轻量级负载（Node + SQLite），2C2G 亦可，部署时配 swap 保险。

### 9.2 形态
Docker Compose 两个服务：`app`（daemon，挂 `/data` 卷）+ `caddy`（TLS 终结）。`deploy.sh` 一键：装 Docker（官方源）→ 起服务 → 健康检查。

### 9.3 前置（一次性）
- 腾讯云控制台防火墙 + 系统 firewalld 放行 80/443。
- DNS：`cortxt.hgl123.icu` A 记录 → `106.55.102.231`（DNSPod）。

### 9.4 备份
M0 起：每日 cron 打包 `/data` 到本机 `/backups`（保留 14 份）。M3 强化：可选推腾讯 COS。

### 9.5 部署时需用户提供（3 项）
1. **SSH**：`root@106.55.102.231` 凭据（密码或密钥）——已选"由我远程部署"。
2. **API key**：聚合平台 key（写入服务器 `.env`）。
3. **DNS**：加 A 记录（或告知 DNSPod 授权方式）。

## 10. 里程碑（每期结束都是可停可用状态）

| 期 | 内容 | 验收标准 |
|----|------|----------|
| **M0 最小可用上线** | 部署链路 + 认证 + 上传入库 + 检索问答 + 基础主题 + briefing | ① 服务器 Compose 一键起 ② 登录后拖拽上传一批 md/pdf ③ 对文档提问答对且**每条回答带可点击出处** ④ 深色霓虹基础主题上线 ⑤ briefing 出现在简报页 |
| **M1 自动化做实** | 定时任务管理 + 手动技能 + 任务页/运行记录 + 对话工具深挖（kb_search/kb_read 接入 agent loop） | 页面可建/停任务；daily-briefing 可改时间；运行记录完整可查；"总结第 3 篇文档"类深挖请求可用 |
| **M2 路由与用量** | 视觉模型接入（图片问答）、主力/兜底手动切换、用量页 | 发图片能答；切换即时生效；usage_records 页面账目与聚合平台后台能对上量级 |
| **M3 知识库增强** | Git 同步（vault 即 repo，定时 pull）、自动备份强化、检索调优（rerank/评估集） | 同步冲突不炸库；备份可恢复演练通过；评估集准确率有基线数字 |

## 11. Non-goals（v2 明确不做，防烂尾护栏）

1. 手机原生 App / Electron 桌面壳 / TUI
2. Live2D / 语音 / 常驻看板娘
3. 多用户 / 账号体系 / 分享发布给别人用
4. MCP / 插件市场 / DAG 可视化工作流编辑器
5. Milvus 等独立向量数据库
6. 代码仓库索引、浏览器剪藏扩展（二期候选，不在 v2 承诺内）
7. 离线可用、本地模型（服务器无 GPU，本地 Ollama 出局）
8. 自动降级路由 / 打分仲裁器（只做确定性分流 + 手动切换）

## 12. 术语表

| 词 | 定义 |
|----|------|
| Vault | 知识库根目录（容器内 `/data/vault`），documents 的真相源 |
| Document | 一个已入库文件，身份 = sha256 |
| Chunk | 文档分块最小检索单元，带页码/标题路径锚点 |
| Hit | 一次检索命中的 chunk + 融合得分 |
| Briefing | 每日定时生成的知识库日报 |
| ModelProfile | 一条模型配置：`role + baseUrl + model`，role ∈ {primary, background, vision, embedding}；失败显式报错，不自动降级 |
| UsageRecord | 一次 LLM/嵌入调用的记账行（强制归因） |
| Run | 任务的一次执行实例 |

## 13. 环境事实存档

- 开发目录：`H:\hgl_blog`（Windows，新建空目录）。
- 目标服务器：腾讯云轻量 106.55.102.231，CentOS Stream 9，全新。
- Pi Agent Harness：`@earendil-works/pi-agent-core` / `pi-ai`（MIT，Node ≥ 22.19，TS ESM，活跃 v0.85.x）。
- 旧版遗产：`H:\day\DESIGN.md`（v1.0 手机方案，作废）、`CortxtOS 开发全流程解析.pdf`（v1 TUI 方案记录，作废）、`H:\deepseek-harness`（Pi fork 参考，仅查阅）。
