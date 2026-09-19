# CortxtOS v2 · 个人 AI 工作台 — 设计文档

**版本** v2.4 · 2026-09-19 · 增量修订（grilling 第四轮：① 网页链接抓取入库；② 检索调优 + 中文评估集；③ 模型阵容可编辑 + 会话级换档。均按推荐裁定）。变更历史见文末「变更日志」。配套：术语纪律见 CONTEXT.md，决策记录见 docs/adr/0001–0004。

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

| 页面 | 状态 | 内容 |
|------|------|------|
| **今天**（默认首页） | 已上线 | 问候语、统计卡、今日简报摘要、快捷提问（直达对话）、快速捕获、最近文档、近 7 日用量 |
| **对话** | 已上线 | 多会话、SSE 流式、引用卡片（内置查看器 / PDF 跳页）、工具深挖提示、贴图提问 |
| **知识库** | 已上线 | 上传（md/txt/pdf ≤50MB）、快速捕获、在线编辑、**标签 + 标题搜索**过滤、删除/重建索引 |
| **简报** | 已上线 | 每日简报列表 + 详情 + 手动生成 |
| **任务** | 已上线 | 自定义定时任务（可勾选"携带知识库检索"）、改时间/启停/删除、运行记录 |
| **用量** | 已上线 | 汇总卡、每日堆叠图、按模型 Top10、明细表按用途筛选（近 7/30 天） |
| **设置** | **v2.4** | 改密；模型阵容**可编辑**（四档 model/baseUrl/apiKeyEnv → 写 config.json → daemon 自重启生效）；key 仍只存 `.env`，永不回显 |

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
- **阵容可编辑（v2.4）**：设置页修改四档 `model` / `baseUrl` / `apiKeyEnv`（key 本体仍只在 `.env`）→ 写服务器 `config.json` → daemon 自重启生效（见 §9.6）；嵌入维度变更触发既有全量重建机制。
- **会话级手动换档（v2.4）**：对话生成失败时提供「切到 background 档重试」按钮；切换仅对当前会话生效、**不落库**，新会话/刷新自动回 `primary`。全局默认档变更走阵容编辑，两者职责不重叠。

### 4.5 网页链接抓取（v2.4 新增）

- **入口**：快速捕获框升级——输入以 `http://` / `https://` 开头的内容即走抓取管线（纯文本仍走原捕获）。
- **管线**：URL 校验（仅公网 http/https，禁内网地址）→ 服务器抓取（UA 标识、30s 超时、2MB 上限）→ `@mozilla/readability` 正文提取（jsdom 解析）→ `turndown` 转 Markdown → 产物写入 Vault → 自动索引。
- **产物形态**：Markdown 文档 = 元信息头（来源 URL、站点名、抓取时间）+ 标题 + 正文；**只存文字不落图片**（图片以原文链接保留）。
- **失败处理**：403 / 防爬 / 超时 / 无正文 → 抓取状态显式报错（不静默），可手动重试；不引入重试队列。
- **依赖**：`@mozilla/readability` + `jsdom` + `turndown`（锁版本）；抓取串行执行，不并发轰炸目标站。

### 4.6 检索调优与评估集（v2.4 新增）

- **评估集**：`eval/eval-set.json`，20~30 条中文问答对（query → 期望文档 [+可选页码]），覆盖单跳/多跳/无答案三类。**基线优先**：`pnpm eval` 输出 top1 / top3 / top6 命中率，作为一切调参的前置与回归护栏。
- **调参项**（每项改动跑评估集对比）：RRF k 值、每路召回数、chunk 大小与重叠、jieba 分词粒度、标题路径（heading_path）是否入 FTS 加权。
- **rerank 定位**：**可选后置**——仅当评估集 top3 命中率低于目标（默认 80%）时启用；rerank 作为第五类 ModelProfile（`kind: rerank`，走 OpenAI 兼容 `/v1/rerank` 端点，供应商不绑定）；未配置 = 不重排序。
- **纪律**：无基线数字不做调参；评估集随知识库实际内容扩充。

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

`documents`(id, title, source, mime, sha256, size, status, **tags**(JSON 数组, v2.3), created_at, updated_at) ·
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
- egress 白名单（v2.4 修订）：① 聚合平台 LLM/嵌入端点；② 可选 rerank 端点；③ **链接抓取目标**——用户输入的公网 URL（仅 http/https、禁内网/环回地址、30s 超时、2MB 上限）。除此之外无外呼（无邮件、无第三方推送）。
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

### 9.6 阵容保存自重启（v2.4）

设置页保存模型阵容 → 写 `config.json` → daemon 延迟 3 秒 `process.exit(0)` → Docker `restart: unless-stopped` 自动拉起（全程约 5 秒）→ 前端轮询 `/healthz` 恢复后刷新。退出前向客户端返回确认，避免请求悬挂。

## 10. 里程碑

**v2.0–v2.3（全部已上线）**：M0 最小可用（部署/认证/入库/检索问答/主题/简报）→ M1 自动化做实（任务 CRUD + 工具深挖）→ M2 路由与用量（图片问答/用量页）→ v2.3 增量（标签组织/快速捕获）。上表历史验收项全部通过实机验收。

**v2.4 里程碑**（各期独立可上线，`update.sh` 支持任意频次更新）：

| 期 | 内容 | 验收标准 |
|----|------|----------|
| **M-A 链接抓取** | 快速捕获 URL 识别 + Readability 抓取管线（§4.5） | ① 贴 3 类页面（技术博客/文档站/含代码块页面）正文完整入库且可检索引用 ② 防爬/超时显式报错可重试 ③ 产物带元信息头，Vault 内可见 |
| **M-C 阵容编辑与换档** | 设置页阵容编辑 + 自重启 + 会话级换档（§4.4/§9.6） | ① 改 primary 模型名保存 → 自重启 → 新对话走新模型且阵容页回显正确 ② 嵌入维度变更触发全量重建 ③ 对话报错一键切 background 档完成本轮，新会话自动回 primary |
| **M-B 检索调优** | 评估集 + 基线 + 调参 + 可选 rerank（§4.6） | ① 评估集 ≥20 条且 `pnpm eval` 出基线数字 ② 至少完成一组调参并附前后对比 ③ rerank 仅在 top3 < 80% 时接入，接入后复测有提升 |

优先顺序：**M-A → M-C → M-B**（B 需要真实使用积累的文档与问题样本，放最后）。

## 11. Non-goals（v2 明确不做，防烂尾护栏）

1. 手机原生 App / Electron 桌面壳 / TUI
2. Live2D / 语音 / 常驻看板娘
3. 多用户 / 账号体系 / 分享发布给别人用
4. MCP / 插件市场 / DAG 可视化工作流编辑器
5. Milvus 等独立向量数据库
6. 代码仓库索引、浏览器剪藏扩展（二期候选，不在 v2 承诺内）
7. 离线可用、本地模型（服务器无 GPU，本地 Ollama 出局）
8. 自动降级路由 / 打分仲裁器（只做确定性分流 + 手动切换）
9. **v2.4 明确推迟**：会话搜索/导出、Git 同步、COS 备份推送、浏览器剪藏扩展（候选池，按使用痛点排序，未入选本轮）

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
| 网页捕获（URL Capture） | v2.4：贴 URL → Readability 提取正文 → 元信息头 + Markdown 入 Vault 自动索引 |
| 评估集（EvalSet） | v2.4：固定中文问答对集合，`pnpm eval` 输出 top1/top3/top6 命中率，一切检索调参的前置与回归护栏 |
| 自重启生效 | v2.4：写 config.json → daemon 延迟退出 → Docker 自动拉起（§9.6），阵容编辑的生效机制 |

## 13. 环境事实存档

- 开发目录：`H:\hgl_blog`（Windows，新建空目录）。
- 目标服务器：腾讯云轻量 106.55.102.231，CentOS Stream 9，全新。
- Pi Agent Harness：`@earendil-works/pi-agent-core` / `pi-ai`（MIT，Node ≥ 22.19，TS ESM，活跃 v0.85.x）。
- 旧版遗产：`H:\day\DESIGN.md`（v1.0 手机方案，作废）、`CortxtOS 开发全流程解析.pdf`（v1 TUI 方案记录，作废）、`H:\deepseek-harness`（Pi fork 参考，仅查阅）。

## 14. 变更日志

- **v2.4（2026-09-19，grilling 第四轮，本文档当前版）**：新增 §4.5 网页链接抓取、§4.6 检索调优与评估集、§9.6 阵容保存自重启；§4.4 增阵容可编辑与会话级换档；§3 信息架构对齐实际页面；§8 egress 白名单修订；§10 里程碑更新（v2.0–v2.3 标注已上线，新增 M-A/M-C/M-B）；§11 推迟项、§12 术语、§6 数据模型同步。
- **v2.3（已上线）**：用量明细页、知识库标签组织（迁移 0002）。
- **v2.2（已上线）**：对话工具深挖（混合式 agent loop）、图片问答（vision 当轮）、快速捕获、任务携带知识库检索、update.sh。
- **v2.1（已上线）**：检索两段式、引用点击边界、模型角色正名（primary/background/vision/embedding）、密码生命周期（DB 为准）。
- **v2.0（已上线）**：三轮 grilling 定稿——自托管取代本地优先、Pi SDK 嵌入、SQLite 派生索引、深色霓虹主题。
