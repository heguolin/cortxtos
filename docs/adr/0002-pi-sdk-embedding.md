# ADR 0002 — Pi 以 SDK 依赖嵌入，不 fork

**状态**：已接受（2026-09-18，用户裁决"其他推荐"）

## 背景

Pi Agent Harness（`@earendil-works/pi-agent-core` / `pi-ai`，MIT，Node ≥ 22.19，TS ESM，上游活跃 v0.85.x）提供可嵌入的 agent loop 与统一多供应商 LLM API。备选：A. npm 依赖嵌入；B. fork 改造；C. 仅借鉴理念自研。

## 决策

**A**——npm 依赖 + lockfile 固定版本；`models.json` 由自家 `config.json` 派生；自定义工具经 Pi 的工具注册机制接入（kb_search / kb_list / kb_read）。

## 后果

- 上游 API 变动需跟版（升级 = 改 lockfile + 回归测试，不追激进更新）。
- 不维护 fork，不背上游代码的演进负担。
- MCP 不引入（Pi 同样默认无 MCP；v2 工具面小，不需要）。
