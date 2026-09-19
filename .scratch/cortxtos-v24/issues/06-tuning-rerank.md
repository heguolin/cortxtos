# 06: 调参实验 + 可选 rerank

**What to build:** 以 05 的基线为对照做至少一组调参实验（RRF k / 每路召回数 / chunk 大小与重叠 / jieba 粒度 / heading_path 入 FTS 加权，选一），附评估集前后对比数字；若基线 top3 < 80% 则接入 rerank ModelProfile（kind: rerank，OpenAI 兼容 /v1/rerank，供应商不绑定，未配置 = 不重排序），复测有提升。ADR 0008。

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] 至少一组调参：改动 + 前后 Hit@1/@3/@6 对比表 + 结论（采纳/回退）
- [ ] top3 ≥ 80%：记录"未达 rerank 门槛，不接入"的数字结论即可
- [ ] top3 < 80%：rerank 接入且复测提升，未配置 rerank 时检索行为与现状完全一致
- [ ] 全量测试绿（含检索既有用例）

ready-for-agent
