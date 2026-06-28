# singbox-urltest-selection Specification

## Purpose
TBD - created by archiving change refactor-to-singbox-urltest. Update Purpose after archive.
## Requirements
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
- **THEN** 最优节点选择由 sing-box `urltest` 单一来源决定，应用层不再执行评分计算与手动切换

