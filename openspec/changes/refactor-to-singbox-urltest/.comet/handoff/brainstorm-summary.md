# Brainstorm Summary

- Change: refactor-to-singbox-urltest
- Date: 2026-06-28

## 确认的技术方案

- 采用 sing-box 原生 `urltest` 作为唯一最优节点选择来源。
- 删除应用层 `monitor + scoring + probe` 的选优职责，不做向后兼容（允许 breaking change）。
- 保留蓝绿双实例与常驻 relay，继续保障切换期间连接不中断。
- 无可用节点时：`/proxy` 返回 `503`（含 reason），relay 拒绝新连接。

## 关键取舍与风险

- 取舍：代码与配置显著简化，但失去应用层细粒度评分可控性。
- 风险：urltest 参数（interval/tolerance）不当可能引发切换抖动；通过合理默认值和测试约束控制。
- 风险：重构涉及测试重写，需覆盖启动、切换、刷新和无可用节点分支。

## 测试策略

- 单元测试：`singbox/config` 生成、`monitor` 行为、`/proxy` 无节点时返回码。
- 集成验证：服务启动后可自动选优；订阅刷新触发蓝绿切换且不中断存量连接。
- 回归验证：`bun run --bun tsc --noEmit` 与现有测试通过。

## Spec Patch

- 已在 change delta spec 中回写：`node-health-monitor` 删除应用层评分与死亡判定要求，新增 `singbox-urltest-selection`。