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
- **文档影响**：`README.md` 与设计文档需同步为新架构。