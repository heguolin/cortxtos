# 01: 裸 URL 抓取端到端

**What to build:** 用户在知识库快速捕获框输入一个裸 http/https 链接回车，daemon 识别为网页捕获 → 抓取（仅公网、UA 标识、30s 超时、2MB 上限）→ Readability 提取正文 → turndown 转 Markdown → 带"来源 URL/站点/抓取时间"元信息头写入 Vault → 自动索引 → 列表可见、可被对话检索并带引用；防爬/超时/无正文显式报错并可重试。混有其他文字的输入仍走纯文本捕获。前端最小状态：抓取中提示 + 失败重试按钮。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 贴 3 类页面（技术博客 / 文档站 / 含代码块页面）正文完整入库且可检索、对话引用出处正确
- [ ] 403/超时/无正文 → 显式报错信息，重试可用
- [ ] 元信息头含来源 URL、站点名、抓取时间；Vault 内文件可见
- [ ] 非裸 URL 输入走纯文本捕获，行为不变
- [ ] 内网/环回地址被拒绝（SSRF 防护）
- [ ] typecheck + 全量测试绿

ready-for-agent
