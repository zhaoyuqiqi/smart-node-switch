## ADDED Requirements

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
