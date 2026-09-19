# 04: 会话级换档 + 重试生成

**What to build:** 对话生成失败（网络/模型错误）时，失败的 assistant 消息旁出现「切 background 档重试」按钮 → 对上一条用户消息用 background 档重跑检索+生成 → 替换失败的 assistant 消息（用户气泡不重复）→ 仅当前会话生效不落库，新会话/刷新自动回 primary。ADR：重试生成语义见 DESIGN §4.4。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent ｜ **已完成**（有状态 mock 测试：失败→重试→原位替换+记账）

- [x] 失败消息出现重试按钮；点击后以 background 档重新生成并替换原失败消息
- [x] 用户气泡不重复；citations/usage 正确落库（purpose 随档位）
- [x] 新会话/刷新后自动回 primary；会话内多次重试稳定
- [x] primary 正常时按钮不出现
- [x] typecheck + 全量测试绿

ready-for-agent ｜ **已完成**（有状态 mock 测试：失败→重试→原位替换+记账）
