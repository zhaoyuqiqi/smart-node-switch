# node-health-monitor Specification

## Purpose
TBD - created by archiving change add-node-health-monitor. Update Purpose after archive.
## Requirements
### Requirement: 订阅拉取与多协议解析
服务 SHALL 在启动时从配置的订阅 URL 拉取内容,对返回的 base64 文本进行解码,并解析其中的代理节点链接。服务 MUST 支持 `trojan://`、`vmess://`、`ss://`、`vless://` 四种协议 URI,并将每个节点映射为统一的内部节点结构。无法识别或解析失败的节点 MUST 被跳过,不得中断其余节点的解析。

#### Scenario: 解析 base64 订阅得到多协议节点
- **WHEN** 订阅 URL 返回 base64 编码的、包含 trojan/vmess/ss/vless 链接的列表
- **THEN** 服务解码并解析出每个受支持协议的节点,生成统一内部结构

#### Scenario: 跳过无法解析的节点
- **WHEN** 订阅中包含一条格式非法或不受支持协议的链接
- **THEN** 服务跳过该条目并继续解析其余节点,不抛出导致流程中断的错误

### Requirement: 经代理的健康检查
服务 SHALL 借助内置 sing-box 二进制,通过被检测节点自身的代理通道,对配置的测试 URL 发起真实 HTTP 请求来检测节点健康度。检查 MUST 测量该请求的延迟(latency,毫秒);请求成功记为一次成功,失败或超时记为一次失败。

#### Scenario: 节点检查成功
- **WHEN** 通过某节点的代理通道请求测试 URL 并收到成功响应
- **THEN** 记录本次延迟为该节点的 latency,并将该节点标记为本轮成功

#### Scenario: 节点检查失败
- **WHEN** 通过某节点的代理通道请求测试 URL 失败或超时
- **THEN** 将该节点标记为本轮失败

### Requirement: 周期性并发检查调度
服务 SHALL 周期性地对每个非死亡节点运行健康检查。检查周期 MUST 可通过配置设置,默认值为 30 秒。同一轮内的检查 MUST 并发执行(基于 p-queue),最大并发数 MUST 可配置,默认值为 10。被标记为死亡的节点在其复活时间到达前 MUST 被跳过。

#### Scenario: 按配置周期循环检查
- **WHEN** 服务运行且检查周期配置为 N 秒
- **THEN** 服务每隔约 N 秒对所有非死亡节点各运行一次健康检查

#### Scenario: 受控并发执行检查
- **WHEN** 一轮检查包含的待检节点数量超过最大并发数
- **THEN** 服务同时进行中的检查数量不超过配置的最大并发数(默认 10),其余排队等待

#### Scenario: 跳过死亡节点
- **WHEN** 某节点处于死亡状态且尚未到达复活时间
- **THEN** 该轮检查跳过该节点

### Requirement: 健康节点过低时自动刷新订阅
服务 SHALL 在可用节点数(lastCheck > 0 且 failCount === 0)低于节点总数的某一占比阈值(默认 10%,且 MUST 可配置)时,重新从订阅 URL 拉取并解析最新节点信息。该判定 MUST 仅在每一轮健康检查完成后进行。刷新完成后,服务 MUST 立即触发一轮健康检查,而不必等待下一个周期。为避免在节点持续不可用时频繁拉取订阅,两次订阅刷新之间 MUST 有最小冷却间隔(可配置,默认 300 秒)。

#### Scenario: 健康占比低于阈值触发刷新
- **WHEN** 一轮检查完成后,可用节点数低于节点总数的配置阈值(默认 10%)且距上次刷新已超过冷却间隔
- **THEN** 服务重新拉取订阅、重建节点集,并立即对最新节点触发一轮健康检查

#### Scenario: 健康占比高于阈值不刷新
- **WHEN** 可用节点数不低于配置阈值
- **THEN** 服务不触发订阅刷新,按既有周期继续检查

#### Scenario: 冷却期内不重复刷新
- **WHEN** 可用占比持续低于阈值,但距上次订阅刷新尚未超过冷却间隔
- **THEN** 服务本轮不再触发订阅刷新,等待冷却结束后再评估

### Requirement: Redis key 过期治理
服务 MUST 为每个节点的状态 key 设置过期时间(默认 2 天),并在每次对该节点状态进行操作时将其过期时间续期 2 天。借此使订阅刷新后不再出现的陈旧节点状态自动过期,避免 Redis 存储无限增长。

#### Scenario: 写入时设置过期
- **WHEN** 某节点的状态首次写入 Redis
- **THEN** 该状态 key 被设置过期时间(默认 2 天)

#### Scenario: 操作时续期
- **WHEN** 某节点的状态被再次读写操作
- **THEN** 该状态 key 的过期时间被续期至 2 天

#### Scenario: 陈旧节点自动过期
- **WHEN** 某节点在续期窗口内不再被任何操作触及
- **THEN** 该节点的状态 key 到期后被 Redis 自动删除

### Requirement: 节点状态持久化到 Redis
服务 SHALL 将每个节点的健康状态(至少包含 latency、failCount、lastCheck)持久化到 Redis,并通过 ioredis 客户端读写。状态 MUST 在每次检查后更新。

#### Scenario: 检查后写入状态
- **WHEN** 某节点完成一次健康检查
- **THEN** 该节点的 latency、failCount、lastCheck 被更新并写入 Redis

### Requirement: 健康评分
服务 SHALL 依据公式 `score = latency * 0.7 + failCount * 100 + (now - lastCheck) * 0.001` 计算每个节点的得分,其中 now 为当前时间戳、lastCheck 为最近一次检查的时间戳。得分越低代表节点越健康。

#### Scenario: 按公式计算得分
- **WHEN** 请求计算某节点的得分
- **THEN** 服务返回 `latency*0.7 + failCount*100 + (now-lastCheck)*0.001` 的结果

#### Scenario: 失败次数主导得分
- **WHEN** 两个节点延迟相近但其一 failCount 更高
- **THEN** failCount 更高的节点得分明显更高(更不健康)

### Requirement: 成功重置失败计数
服务 MUST 在某节点一次健康检查成功后,将该节点的 failCount 重置为 0。

#### Scenario: 成功后归零失败计数
- **WHEN** 某节点此前 failCount 大于 0,随后一次健康检查成功
- **THEN** 该节点的 failCount 被重置为 0

### Requirement: 连续失败死亡判定与复活
服务 MUST 在某节点连续失败次数达到死亡阈值(默认 20,且 MUST 可配置)时,将该节点标记为死亡。死亡节点 SHALL 在复活时长(默认 24 小时,且 MUST 可配置)后自动恢复检查,该死亡状态及到期 MUST 借助 Redis 实现。

#### Scenario: 连续失败达到阈值标记死亡
- **WHEN** 某节点连续失败次数达到配置的死亡阈值
- **THEN** 该节点被标记为死亡,并设定在复活时长之后到期

#### Scenario: 复活时长后恢复检查
- **WHEN** 某死亡节点已超过其复活时间
- **THEN** 该节点恢复为可被检查状态,后续周期重新对其检查

### Requirement: 查询全部可用节点 API
服务 SHALL 提供 `GET /nodes` 接口,返回全部可用节点及其数量。可用节点定义为:**至少检查过一次(lastCheck > 0)且最近一次健康检查成功(failCount === 0)** 的节点。从未检查成功过的新节点(lastCheck === 0)和处于死亡状态的节点 MUST 不计入可用。

#### Scenario: 返回可用节点及数量
- **WHEN** 客户端请求 `GET /nodes`
- **THEN** 服务返回所有 lastCheck > 0 且 failCount === 0 的节点列表及其总数

#### Scenario: 排除失败或死亡节点
- **WHEN** 存在 failCount 大于 0 或处于死亡状态的节点
- **THEN** 这些节点不出现在 `GET /nodes` 的可用节点结果中

#### Scenario: 排除从未检查过的新节点
- **WHEN** 某节点刚被订阅解析加入但尚未完成任何一次健康检查(lastCheck === 0)
- **THEN** 该节点不出现在 `GET /nodes` 的可用节点结果中

### Requirement: 查询最健康节点 API
服务 SHALL 提供 `GET /nodes/best` 接口,返回当前得分最低(最健康)的节点。

#### Scenario: 返回得分最低节点
- **WHEN** 客户端请求 `GET /nodes/best`
- **THEN** 服务返回所有可选节点中 score 最低的那个节点

#### Scenario: 无可用节点时的响应
- **WHEN** 当前没有任何可用节点
- **THEN** 服务返回表示「无可用节点」的明确响应,而非任意节点

