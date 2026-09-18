# 07 · 调度器 + 每日 Briefing

**What to build**
- 进程内 cron 调度器（分钟粒度）+ `jobs` / `runs` 表打通。
- 内置 Job `daily-briefing`：默认每日 08:00（config 可改）；扫描过去 24h 新增/变更文档 → 走 `background` 档生成摘要（提示词模板可配）→ 产物落简报页。
- 简报页：列表 + 详情；运行记录（状态/起止/耗时/输出/报错）。
- `usage_records(purpose='background')` 强制落库。

**Blocked by** 04（可与 05/06 并行开发）

**验收清单**
- [x] 手动触发 Run → 生成 briefing 落库并在简报页可见
- [x] 24h 无新文档 → 生成"今日无更新"占位，不报错
- [x] 运行记录完整（状态/耗时/输出）；失败可见报错
- [x] 修改 cron 时间后按新时间调度

ready-for-agent: ✅ **已完成**

> 实现备注: 全部验收项由自动化测试 + 活体冒烟覆盖（commit d1ecb0c）。真实 key 相关的终验项挪到票 08 现场过。
