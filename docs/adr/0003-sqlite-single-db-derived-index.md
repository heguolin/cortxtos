# ADR 0003 — SQLite 单库派生索引，Vault 为真相源

**状态**：已接受（2026-09-18，用户裁决"其他推荐"）

## 背景

检索栈备选：A. SQLite 全家桶（WAL + FTS5 + sqlite-vec）；B. LanceDB + BM25；C. 沿用博客的 Python FastAPI + Milvus。用户上一版痛点 ② = 检索质量差/没建起来；v1 的 PDF 方案曾用 MinerU 等重管线但烂尾。

## 决策

**A**。单个 SQLite 库承载全部结构化数据 + 全文索引 + 向量索引；`/data/vault` 中的原始文件是**真相源**，库是**派生索引**，可随时从 Vault 全量重建（`reindex` 语义）。

## 后果

- 备份 = 一个文件 + 一个目录，个人规模（万级 chunk）性能绰绰有余。
- 拒绝 Milvus/独立向量库：VPS 上太重，运维面过大。
- 抽文本/分块/嵌入任一环节失败 → Document 标记失败态可重试，绝不污染真相源。
- 中文分词是 FTS5 质量的关键前提 → 见 ADR 0004。
