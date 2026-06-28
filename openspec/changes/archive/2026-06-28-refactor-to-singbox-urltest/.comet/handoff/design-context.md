# Comet Design Handoff

- Change: refactor-to-singbox-urltest
- Phase: design
- Mode: compact
- Context hash: 0d19c1b35600859b88214852ff28c3aea8353cb42d9359a753fb3e3e6cc01705

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/refactor-to-singbox-urltest/proposal.md

- Source: openspec/changes/refactor-to-singbox-urltest/proposal.md
- Lines: 1-24
- SHA256: 491c16a1edb162b71111955185822fe365763791a6c517f3cf5ffba86d813d83

```md
## Why

当前项目自行实现了节点测速、评分与最优节点切换（`monitor` + `probe` + `scoring` + Clash selector 热切），与 sing-box 原生 `urltest` 能力存在重复，带来实现复杂度、维护成本与运行时额外开销。既然项目尚未上线且允许 breaking change，现阶段适合进行一次彻底收敛：让 sing-box 原生负责最优节点选择，本项目聚焦在订阅刷新与无中断蓝绿切换。

## What Changes

- **BREAKING**：移除自研“逐节点探测 + 评分 + 手动 selector 切换”主链路，改为 sing-box `urltest` 出站自动选优。
- **BREAKING**：删除或瘦身 `monitor/scoring/probe` 相关职责，`monitor` 仅保留“可用性观察 + 订阅刷新触发 + 蓝绿编排联动”。
- **BREAKING**：调整 sing-box 配置生成逻辑，不再为每个节点分配独立探测入口端口；由单一代理入口接入 `urltest`。
- 更新测试与文档，改为描述“urltest 自动选优 + 蓝绿更新不中断”的新行为。

## Capabilities

### New Capabilities
- `singbox-urltest-selection`: 基于 sing-box 原生 `urltest` 的自动最优节点选择能力。

### Modified Capabilities
- `node-health-monitor`: 从“应用层自研评分选优”改为“原生 urltest 选优 + 应用层刷新与编排”。

## Impact

- **代码影响**：`src/singbox/config.ts`、`src/monitor.ts`、`src/index.ts`、`src/scoring.ts`、`src/singbox/probe.ts` 及相关测试。
- **运行时影响**：端口占用下降（不再每节点一个探测入站）、选优链路简化、IPC 控制路径减少。
- **接口/行为影响**：属于 breaking change，不承诺旧内部状态模型与旧评分路径兼容。
- **文档影响**：`README.md` 与设计文档需同步为新架构。```

## openspec/changes/refactor-to-singbox-urltest/design.md

- Source: openspec/changes/refactor-to-singbox-urltest/design.md
- Lines: 1-65
- SHA256: dca65167d34bc0acaebd3f75f6d3bbf95e7eda04bdc8fef9e6f73c338f60c072

```md
## Context

当前实现通过应用层 `monitor + probe + scoring` 维护节点状态，并使用 Clash API 手动切换 selector。这套方案与 sing-box 原生 `urltest` 职责重叠，导致：
- 配置复杂（每节点独立探测路径与端口）
- 代码面广（探测、评分、切换、持久化耦合）
- 运行开销增加（应用层探测 + 控制面 IPC）

本次重构目标是把“最优节点选择”下沉到 sing-box 内核，应用层仅保留“订阅刷新决策 + 蓝绿实例编排 + 对外固定代理入口”。项目尚未上线，允许 breaking change。

## Goals / Non-Goals

**Goals:**
- 使用 sing-box `urltest` 出站自动测速并选择最优节点。
- 删除应用层自研评分与主动切换链路。
- 保留并继续强化蓝绿切换与连接不中断能力。
- 缩减端口占用和配置复杂度。

**Non-Goals:**
- 不新增代理协议。
- 不做向后兼容层。
- 不改部署模型（Bun + sing-box + Docker）。

## Decisions

- **决策 1：由 sing-box `urltest` 接管选优**
  - 方案：配置 `urltest` outbound（成员为所有节点 outbound），代理入口路由到该 outbound。
  - 原因：内核层探测与切换效率更高，减少应用层逻辑。
  - 备选方案：继续保留应用层评分，只把部分指标交给 sing-box；被否决，因复杂度仍高。

- **决策 2：移除 per-node 探测入口与评分模块**
  - 方案：删除/瘦身 `probe`、`scoring`、`monitor` 的选优职责，不再维护“每节点探测端口”。
  - 原因：避免重复实现、降低维护成本。
  - 备选方案：保留模块但停用；被否决，因易产生死代码和误导。

- **决策 3：保留蓝绿双实例 + 常驻 relay**
  - 方案：订阅刷新仍通过编排器启动新实例并原子切换 relay 上游，旧实例优雅排空。
  - 原因：这是项目核心价值（更新不中断），与 urltest 不冲突。
  - 备选方案：直接重启单实例；被否决，因会带来可感知中断窗口。

- **决策 4：刷新触发由“应用层可用性观察”驱动，而非评分驱动**
  - 方案：通过已有状态（如 Clash API 的节点可用性信息）判断是否触发订阅刷新。
  - 原因：去掉评分后仍需保留自动刷新能力。
  - 备选方案：改为固定周期强制刷新；被否决，因无效刷新较多。

## Risks / Trade-offs

- [urltest 参数不当可能导致切换抖动] → 通过 `tolerance`、`interval` 和连接不中断策略控制。
- [移除旧模块导致测试大面积失效] → 同步重写关键测试，优先覆盖启动、选优、刷新、蓝绿切换。
- [无可用节点时行为变化] → 显式定义 `/proxy` 与 relay 行为，避免隐式失败。
- [breaking change 影响开发习惯] → 在 README 和设计文档中给出迁移说明。

## Migration Plan

1. 调整 `singbox/config`：引入 `urltest`，移除 per-node 探测入口依赖。
2. 重构 `monitor`：删除评分与切换职责，仅保留刷新判定与编排触发。
3. 清理 `scoring/probe` 及其引用，更新 `index` 装配。
4. 修复并重写相关测试（单元 + 关键集成）。
5. 更新 README 与 OpenSpec 文档，完成行为说明。

回滚策略：若重构阶段出现阻塞，可回退到本变更前 commit；本次不引入双栈兼容路径。

## Open Questions

- 刷新判定优先读取哪个来源（Clash API 统计 vs 本地轻量状态）？
- 无可用节点时是否统一返回 `503`（含 reason）？
- `urltest` 默认参数（interval/tolerance/idle_timeout）采用何值最稳妥？```

## openspec/changes/refactor-to-singbox-urltest/tasks.md

- Source: openspec/changes/refactor-to-singbox-urltest/tasks.md
- Lines: 1-22
- SHA256: f344a5084d64dc73e850ebd007a1a1e9135a56ef50fedc6b85232b187c27854c

```md
## 1. sing-box 配置重构（urltest 接管选优）

- [ ] 1.1 在 `src/singbox/config.ts` 引入 `urltest` outbound，候选集覆盖节点 outbounds
- [ ] 1.2 调整代理入口路由到 `urltest`，移除依赖应用层手动 selector 切换的配置
- [ ] 1.3 清理 per-node 探测入站端口相关配置与映射依赖

## 2. 应用层职责瘦身

- [ ] 2.1 重构 `src/monitor.ts`：删除评分/手动切换职责，仅保留刷新判定与编排触发
- [ ] 2.2 移除 `src/scoring.ts` 与 `src/singbox/probe.ts` 的核心运行时依赖（必要时删除文件）
- [ ] 2.3 更新 `src/index.ts` 装配链路，确保与新 monitor/sing-box 配置一致

## 3. 测试重建与回归

- [ ] 3.1 更新受影响单元测试（config、monitor、orchestrator 相关）
- [ ] 3.2 删除或改写基于旧评分模型的测试用例
- [ ] 3.3 运行 `bun run --bun tsc --noEmit` 与项目测试，修复失败项

## 4. 文档与对外说明

- [ ] 4.1 更新 `README.md`：说明 `urltest` 自动选优行为与关键参数
- [ ] 4.2 更新设计/计划文档中“自研评分选优”表述为“原生 urltest 选优”
- [ ] 4.3 补充 breaking change 说明（不保证向后兼容）```

## openspec/changes/refactor-to-singbox-urltest/specs/node-health-monitor/spec.md

- Source: openspec/changes/refactor-to-singbox-urltest/specs/node-health-monitor/spec.md
- Lines: 1-39
- SHA256: 250304498d1592441475e97c025801fbaed4bd2d88588396e0bbe3d29836b1b7

```md
## MODIFIED Requirements

### Requirement: 经代理的健康检查
服务 SHALL 借助内置 sing-box 二进制,通过统一代理入口对配置的测试 URL 发起真实 HTTP 请求来检测整体代理可达性。该检查 MUST 用于刷新判定与运行状态观察,而不是用于应用层最优节点选择。

#### Scenario: 统一代理入口检查成功
- **WHEN** 通过服务统一代理入口请求测试 URL 并收到成功响应
- **THEN** 服务记录本轮可达性检查成功,并将其用于刷新判定

#### Scenario: 统一代理入口检查失败
- **WHEN** 通过服务统一代理入口请求测试 URL 失败或超时
- **THEN** 服务记录本轮可达性检查失败,并据此参与刷新阈值判断

### Requirement: 周期性并发检查调度
服务 SHALL 周期性执行健康检查调度。检查周期 MUST 可通过配置设置。实现 MAY 并发执行检查任务,但不得再要求“逐节点独立探测并发队列”作为必选实现路径。

#### Scenario: 按配置周期循环检查
- **WHEN** 服务运行且检查周期配置为 N 秒
- **THEN** 服务每隔约 N 秒执行一次健康检查轮次

#### Scenario: 调度实现不强制逐节点探测
- **WHEN** 服务使用 sing-box 原生 urltest 作为选优机制
- **THEN** 调度层无需维护逐节点独立探测任务队列仍视为符合要求

### Requirement: 健康评分
服务 SHALL 将节点最优性判定职责下沉至 sing-box 原生 `urltest`，应用层不再维护或要求固定评分公式。

#### Scenario: 最优性判定由 urltest 提供
- **WHEN** 系统需要确定当前最优节点
- **THEN** 系统以 sing-box `urltest` 结果作为唯一判定来源

## REMOVED Requirements

### Requirement: 成功重置失败计数
**Reason**: 该要求属于应用层评分模型的一部分，重构后应用层不再维护连续失败计数作为最优节点判定核心。
**Migration**: 改由 sing-box `urltest` 内部测速与容忍阈值策略管理最优节点切换，应用层仅保留刷新与编排职责。

### Requirement: 连续失败死亡判定与复活
**Reason**: 该要求绑定于应用层逐节点探测模型。重构后最优节点选择交由 sing-box，应用层不再承担节点死亡生命周期管理。
**Migration**: 通过 `urltest` 候选集合与订阅刷新机制维持可用节点集合，必要时在后续 change 引入新的可用性治理策略。```

## openspec/changes/refactor-to-singbox-urltest/specs/singbox-urltest-selection/spec.md

- Source: openspec/changes/refactor-to-singbox-urltest/specs/singbox-urltest-selection/spec.md
- Lines: 1-21
- SHA256: 8a3f4518b56f0aa2fe40b87a44c9476a891bce74b7af089433c5416281dfdee3

```md
## ADDED Requirements

### Requirement: 基于 urltest 的自动最优节点选择
服务 MUST 使用 sing-box 原生 `urltest` outbound 作为节点自动选择机制。`urltest` 的候选集合 SHALL 覆盖当前订阅解析出的全部可用节点 outbound，代理入口流量 MUST 路由到该 `urltest` outbound。

#### Scenario: 启动后自动选优生效
- **WHEN** 服务启动并成功加载节点列表
- **THEN** sing-box 使用 `urltest` 对候选节点测速并选择当前最优节点处理新连接

### Requirement: 选优切换不应中断既有连接
服务 MUST 在最优节点变更时保持已建立连接不断开，仅让新连接按新最优节点建立。

#### Scenario: 最优节点切换期间长连接持续可用
- **WHEN** `urltest` 选中的最优节点发生变化
- **THEN** 已建立连接继续在原路径上传输，新建连接走新的最优节点

### Requirement: 不再依赖应用层评分切换
服务 SHALL 不再依赖应用层 `score` 公式与主动 selector 切换作为最优节点判定依据。

#### Scenario: 运行路径中不存在应用层评分选优
- **WHEN** 服务执行健康监测与代理转发流程
- **THEN** 最优节点选择由 sing-box `urltest` 单一来源决定，应用层不再执行评分计算与手动切换```

