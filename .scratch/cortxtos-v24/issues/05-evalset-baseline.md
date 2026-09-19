# 05: 评估集 + 基线

**What to build:** `eval/eval-set.json`（20~30 条中文问答对：query → 期望文档 [+可选页码]，从真实会话问题挑选 + 人工标注，覆盖单跳/多跳/无答案三类）+ `pnpm eval` 脚本（调真实嵌入 + 现有混合检索，输出文档级 Hit@1/@3/@6 与逐条明细）+ package.json script 挂载。产出第一份基线数字，作为 06 调参的对照与回归护栏。ADR 0008。

**Blocked by:** None (can start immediately)——**标注建议等真实使用攒一批会话后再定稿条目**

**Status:** ready-for-agent

- [ ] eval-set ≥ 20 条且三类覆盖；格式含 query/expectDocument（可选 page）
- [ ] `pnpm eval` 跑通：输出 Hit@1/@3/@6 汇总 + 逐条命中明细
- [ ] 连跑两次数字稳定（确定性检索路径）
- [ ] 基线数字记入 eval/README（或运行输出末尾），作为 06 的对照
- [ ] typecheck + 全量测试绿

ready-for-agent
