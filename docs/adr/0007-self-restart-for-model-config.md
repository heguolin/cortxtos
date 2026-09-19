# ADR 0007 — 模型阵容编辑采用自重启生效，放弃热加载

**状态**：已接受（2026-09-19，grilling 第四轮 + grill-with-docs 补边界）

## 背景

设置页要支持编辑四档模型（model/baseUrl/apiKeyEnv）。生效方式两难：热加载（daemon 运行中重建 ModelProfile/嵌入客户端）零中断，但要在内存里管理重建逻辑，且嵌入维度变更牵扯向量表全量重建，隐藏状态多；自重启简单可靠但保存后服务短暂不可用。

## 决策

**写盘前 zod dry-run → 写 config.json → daemon 延迟 3 秒 process.exit(0) → Docker `restart: unless-stopped` 自动拉起**（全程约 5 秒，前端轮询 `/healthz`）。轮询 30 秒未恢复 → 前端显示逃生通道提示（查 `docker compose logs app` / 手动修 `data/config.json`）。

## 后果

- dry-run 挡住 99% 的写坏配置场景（校验不过不写盘不重启）；剩余极端情况有明确手动兜底。
- 5 秒重启对单用户完全可接受；换来的实现是"写文件 + 退出"，几乎没有新增状态。
- 会话级手动换档（ADR 语义见 DESIGN §4.4：重试生成）与全局阵容编辑职责分离——前者应急、后者变更。
- key 本体仍只存 `.env`，config.json 只存 `apiKeyEnv` 环境变量名。
