# 03: 阵容编辑 + 自重启生效

**What to build:** 设置页模型阵容从只读变可编辑（四档 model/baseUrl/apiKeyEnv，key 本体仍只在 .env）→ 保存走 zod dry-run（不过不写盘直接提示）→ 写 config.json → daemon 延迟 3 秒退出自重启 → 前端轮询 /healthz（30s 超时显示逃生提示：查日志/手动修 config）。嵌入维度变更触发既有全量重建。ADR 0007。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent ｜ **已完成**（dry-run 拦截 + 写盘 + 自重启钩子 4 例测试）

- [x] 改 primary 模型名保存 → 自重启 → 新对话走新模型，阵容页回显正确
- [x] 非法值（错 baseUrl/超范围维度）→ dry-run 拦截，config 未被写坏
- [x] 嵌入维度变更 → 全量重建触发且文档最终 ready
- [x] 前端"重启中…"到恢复全程有反馈；30s 超时显示逃生提示
- [x] typecheck + 全量测试绿

ready-for-agent ｜ **已完成**（dry-run 拦截 + 写盘 + 自重启钩子 4 例测试）
