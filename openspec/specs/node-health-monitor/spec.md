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
服务 SHALL 将节点最优性判定职责下沉至 sing-box 原生 `urltest`，应用层不再维护或要求固定评分公式。

#### Scenario: 最优性判定由 urltest 提供
- **WHEN** 系统需要确定当前最优节点
- **THEN** 系统以 sing-box `urltest` 结果作为唯一判定来源

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

### Requirement: 查询接口返回完整节点信息
`GET /nodes` 与 `GET /nodes/best` 返回的每个节点对象 MUST 包含该节点的完整信息,除既有的 key、name、protocol、server、port、latency、failCount、lastCheck、score 外,还 MUST 包含从订阅解析得到的协议特定字段(`raw`,如 password、sni、type、uuid、传输参数等)以及该节点的原始订阅链接(原始 URI)。完整信息来源于服务内存中保存的已解析节点,不要求在 Redis 中额外持久化这些字段。

#### Scenario: /nodes 返回含 raw 与原始信息的节点
- **WHEN** 客户端请求 `GET /nodes`
- **THEN** 返回的每个节点对象包含 raw(协议特定字段)与原始订阅链接,而不仅是 protocol/server/port 等基础字段

#### Scenario: /nodes/best 返回含 raw 与原始信息的节点
- **WHEN** 客户端请求 `GET /nodes/best` 且存在可用节点
- **THEN** 返回的 best 节点对象同样包含 raw 与原始订阅链接

### Requirement: sing-box 本地端口分配跳过占用
服务为节点分配本地监听端口时 MUST 探测候选端口是否已被占用,并跳过被占用的端口、改用下一个空闲端口。某些起始端口被占用 MUST NOT 导致 sing-box 启动失败;受影响节点 MUST 仍获得一个可用端口并正常参与健康检查。

#### Scenario: 起始端口段存在占用仍能启动
- **WHEN** 配置的起始端口段中有部分端口已被其它进程占用
- **THEN** 服务跳过被占用端口、为各节点分配空闲端口,sing-box 正常启动,占用端口对应位置不再导致启动失败

#### Scenario: 分配端口与实际占用一致
- **WHEN** 服务完成端口分配
- **THEN** 端口映射(portMap)记录的是每个节点实际分配到的空闲端口

