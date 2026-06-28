---
comet_change: refactor-to-singbox-urltest
role: technical-design
canonical_spec: openspec
---

## 背景

当前项目在应用层实现了节点探测、评分与 selector 切换，这与 sing-box 原生 `urltest` 能力重叠。该重复实现带来了端口占用增加、代码复杂度上升与维护负担。项目尚未上线，允许 breaking change，因此选择进行一次彻底收敛。

## 目标

- 用 sing-box 原生 `urltest` 接管最优节点选择。
- 移除应用层评分与手动切换链路。
- 保留蓝绿双实例与常驻 relay，确保更新期间连接不中断。
- 明确无可用节点时的行为：`/proxy` 返回 `503` 且 relay 拒绝新连接。

## 非目标

- 不做向后兼容。
- 不新增协议支持。
- 不改变部署模式（Bun + sing-box + Docker）。

## 架构决策

### 1) 选优职责下沉到 sing-box

在 `sing-box` 配置中引入 `urltest` outbound，候选集为所有节点 outbound，代理入口路由到该 outbound。这样可由内核层完成测速和切换，降低应用层复杂度。

### 2) 删除应用层评分选优路径

`monitor` 不再负责“逐节点探测 + score 计算 + selector 热切”。`scoring`、`probe` 相关运行时链路移除，避免重复职责和状态漂移。

### 3) 保留蓝绿编排与 relay

订阅刷新仍采用“拉起新实例 -> 就绪探测 -> 原子切 relay 上游 -> 优雅排空旧实例”流程。该能力是项目核心价值，不受 urltest 方案影响。

### 4) 无可用节点行为显式化

当无可用节点时，管理接口 `GET /proxy` 返回 `503` 并附带 reason；relay 拒绝新连接，避免隐式失败或长时间悬挂。

## 关键风险与缓解

- `urltest` 参数不当导致切换抖动：通过 `interval` + `tolerance` 默认值与测试约束控制。
- 大范围重构引发测试失效：同步改造配置、monitor、API 与集成测试。
- breaking change 带来的行为差异：README 与 OpenSpec 文档显式标注。

## 测试策略

- 单元测试：`singbox/config` 输出、`monitor` 刷新逻辑、`/proxy` 无节点分支。
- 集成测试：自动选优可用、刷新触发蓝绿切换不中断。
- 回归验证：`bun run --bun tsc --noEmit` + 全量测试通过。

## 实施顺序

1. `singbox/config` 改为 urltest 选优路径。
2. `monitor` 去除评分/切换职责，保留刷新与编排。
3. 清理 `scoring/probe` 及调用链。
4. 调整 API 与 relay 在无节点时行为。
5. 更新测试与文档。