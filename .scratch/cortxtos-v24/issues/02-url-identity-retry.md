# 02: URL 身份与重抓覆盖

**What to build:** 同一 URL 重抓 = 覆盖原文档而非新增：迁移加 `documents.url`（唯一）→ 重抓时删旧建新、标签保留迁移、索引干净重建 → 前端提示"已覆盖"；重抓内容完全相同则幂等跳过。ADR 0005。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 迁移幂等：0003_url 列 + 唯一索引，旧文档 url 为 NULL 不受影响
- [ ] 同 URL 重抓 → 只剩一份文档（最新内容），标签保留，检索引用指向新版
- [ ] 重抓内容相同 → 幂等跳过不重复入库
- [ ] 网页文档在列表/引用中的标题与来源正确
- [ ] typecheck + 全量测试绿

ready-for-agent
