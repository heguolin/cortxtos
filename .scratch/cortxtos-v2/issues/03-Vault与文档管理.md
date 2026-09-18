# 03 · Vault：上传、文档列表、删除、在线编辑

**What to build**
- 拖拽/选择上传 `.md` `.txt` `.pdf`，单文件 ≤ 50MB（超限友好报错）；文件写入 `/data/vault`（**真相源**，ADR 0003）。
- `documents` 表登记：sha256 身份（重复上传幂等，不产生第二行）、size、mime、状态 `queued`。
- 知识库页：文档列表（文件名/大小/状态/时间）+ 删除（**删文件 + 删索引行原子完成**）。
- 在线 Markdown 编辑器（极简）：打开 Vault 内 md → 编辑 → 保存即重写源文件（状态回到 `queued` 待重建索引）。

**Blocked by** 02

**验收清单**
- [ ] 上传 md 与 pdf 各一个 → Vault 出现文件、列表出现行（状态 queued）
- [ ] 同内容重复上传 → 不新增行（sha256 幂等）
- [ ] 删除 → 文件与 DB 行同时消失，无孤儿
- [ ] 在线编辑保存 → Vault 文件内容变更、状态回 queued
- [ ] 51MB 文件 → 拒绝，错误信息明确

ready-for-agent: ✅（依赖 02）
