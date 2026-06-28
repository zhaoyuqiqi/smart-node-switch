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
**Migration**: 通过 `urltest` 候选集合与订阅刷新机制维持可用节点集合，必要时在后续 change 引入新的可用性治理策略。