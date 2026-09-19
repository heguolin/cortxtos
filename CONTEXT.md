# CONTEXT.md — CortxtOS v2 词汇表

**纪律**：DESIGN.md、代码、提交信息、对话统一使用下表术语；「Avoid」列为禁用语，出现即视为缺陷。每解决一个新术语/更名，同步更新本表。

| 术语 | 定义 | Avoid（禁用语） |
|------|------|----------------|
| **Vault** | 知识库根目录（容器内 `/data/vault`），所有 Document 文件的**真相源**；SQLite 索引是派生物，可随时由 Vault 重建 | 知识库文件夹、数据库目录 |
| **Document** | 一个已入库文件；**文件捕获**（上传/快速捕获）身份 = 内容 sha256；**网页捕获**业务身份 = 来源 URL（同 URL 重抓 = 覆盖原文档并保留标签，不留历史版本） | 附件、资料 |
| **Reindex** | 从 Vault 全量重建派生索引（SQLite 可删可重建，Vault 永远是真相源） | 修复索引、同步 |
| **Chunk** | 检索最小单元，携带 `document_id + page + heading_path` 锚点 | 片段 |
| **Hit** | 一次检索命中（Chunk + 融合得分） | 结果 |
| **命中（Hit@k）** | 检索评估指标：期望**文档**出现在检索结果前 k 名即命中（文档级，不看 chunk）；top1/top3/top6 为标准口径 | 召回率、准确率（语义混淆） |
| **会话级换档** | 对话生成失败时，仅当前会话临时改用 background 档；不落库，新会话/刷新自动回 primary | 降级、兜底、fallback |
| **重试生成** | 对上一条用户消息用指定档重跑「检索 + 生成」，替换失败的 assistant 消息；用户气泡不重复插入 | 重新发送、重发消息 |
| **网页捕获（URL Capture）** | 以**裸 URL**（输入 trim 后整体即合法 http/https 链接）触发的抓取入库；混有其他文字一律走纯文本捕获，不猜意图 | 剪藏、爬虫、智能识别 |
| **Session / Message** | 对话会话 / 消息；Message 携带 citations 与 usage | 聊天记录 |
| **Citation** | 引用 = 文档名 + 页码/标题路径锚点，UI 中可点击 | 参考链接 |
| **Briefing** | 每日定时生成的知识库日报，落简报页 | 日报、推送 |
| **Job / Run** | 定时或手动任务 / 任务的一次执行实例 | 工作流（v2 无 Workflow 概念） |
| **ModelProfile** | 一条模型配置：`role + baseUrl + model`；role 固定四档——`primary`（chat）/ `background`（Briefing·摘要·标题等后台杂活）/ `vision`（图片问答，M2）/ `embedding`（嵌入）。任何档失败显式报错，**不存在自动降级** | 兜底、fallback、降级、接盘 |
| **UsageRecord** | 一次 LLM/嵌入调用的记账行（model + purpose + tokens），**强制落库** | 账单 |
| **purpose** | UsageRecord 归因维度，固定枚举 `chat / background / embed`（+M2 `vision`） | 类型 |
| **主轴 / 副轴** | 知识库问答 / 自动化简报 | 核心功能 |
| **Arbiter** | **不存在**。v2 只有确定性分流（chat→primary，杂活→background），无打分仲裁 | 路由器打分、智能调度 |
