---
change: refactor-to-singbox-urltest
design-doc: docs/superpowers/specs/2026-06-28-refactor-to-singbox-urltest-design.md
base-ref: 5a30e22094c41b121d658d4ff32c06bf28574382
---

# URLTest 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将最优节点选择从应用层 `monitor/scoring/probe` 迁移到 sing-box 原生 `urltest`，并保留蓝绿切换与刷新能力。

**Architecture:** 在 `singbox/config` 中引入 `urltest` outbound，统一代理入口走 `urltest`。应用层删除评分与手动 selector 切换职责，仅保留刷新触发和编排。无可用节点时由 API/relay 明确返回失败语义。

**Tech Stack:** Bun、TypeScript、Elysia、ioredis、sing-box（with clash api）

## Global Constraints

- 允许 breaking change，不做向后兼容。
- 保留蓝绿双实例与常驻 relay 的不中断切换能力。
- 无可用节点时 `GET /proxy` 必须返回 `503`（含 reason），relay 拒绝新连接。
- 所有改动必须通过 `bun run --bun tsc --noEmit` 与测试集验证。

---

### Task 1: 重构 sing-box 配置为 urltest 选优

**Files:**
- Modify: `src/singbox/config.ts`
- Modify: `src/types.ts`（如需配置项类型调整）
- Test: `src/singbox/config.test.ts`

**Interfaces:**
- Consumes: 现有节点列表、配置对象
- Produces: `buildConfig(...)` 生成包含 `urltest` 的最终 sing-box 配置

- [x] **Step 1: 更新配置生成逻辑，加入 `urltest` outbound 并让代理入口走 `urltest`**
- [x] **Step 2: 移除 per-node 探测入站依赖与相关端口映射输出（保留业务必须字段）**
- [x] **Step 3: 更新对应单元测试断言（`urltest` 存在、路由目标正确）**
- [x] **Step 4: 运行配置相关测试并修正失败**

### Task 2: 删除应用层评分与手动切换职责

**Files:**
- Modify: `src/monitor.ts`
- Modify: `src/index.ts`
- Delete/Modify: `src/scoring.ts`
- Delete/Modify: `src/singbox/probe.ts`
- Modify: `src/monitor.test.ts`

**Interfaces:**
- Consumes: orchestrator、state store、订阅拉取
- Produces: 仅负责刷新判定与触发编排，不再提供 score/selector 逻辑

- [x] **Step 1: 在 `monitor` 中移除评分与 selector 切换调用链**
- [x] **Step 2: 保留并校正刷新触发逻辑（仍可驱动 blue/green 更新）**
- [x] **Step 3: 清理 `index` 装配中的无效依赖与注入**
- [x] **Step 4: 清理 `scoring/probe` 代码与引用，确保构建可过**
- [x] **Step 5: 更新 monitor 相关测试**

### Task 3: 无可用节点行为显式化

**Files:**
- Modify: `src/api.ts`
- Modify: `src/relay.ts`（若需要无上游时拒绝策略）
- Modify: `src/index.ts`（必要接线）
- Test: `src/api.test.ts`、`src/relay.test.ts`（如存在）

**Interfaces:**
- Consumes: monitor 当前可用状态、relay 当前上游
- Produces: `/proxy` 在无节点时返回 503 + reason；relay 拒绝新连接

- [x] **Step 1: 修改 `/proxy` 接口无节点分支返回 `503` 与结构化 reason**
- [x] **Step 2: 调整 relay 在无有效上游时拒绝新连接（避免挂起）**
- [x] **Step 3: 增加/更新测试覆盖这两个分支**

### Task 4: 回归验证与文档更新

**Files:**
- Modify: `README.md`
- Modify: `openspec/changes/refactor-to-singbox-urltest/tasks.md`
- Modify: 受影响测试文件

**Interfaces:**
- Consumes: 新行为与测试结果
- Produces: 文档一致性与可验证交付

- [x] **Step 1: 更新 README，说明 urltest 自动选优与 breaking change**
- [x] **Step 2: 执行 `bun run --bun tsc --noEmit`**
- [x] **Step 3: 执行测试并修复回归问题**
- [x] **Step 4: 勾选 OpenSpec tasks 中已完成项，保持变更状态一致**