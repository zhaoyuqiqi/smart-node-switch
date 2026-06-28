# best-proxy-gateway Specification

## Purpose
TBD - created by archiving change add-best-proxy-gateway. Update Purpose after archive.
## Requirements
### Requirement: 固定转发代理入口
服务 MUST 对外提供一个固定的转发代理入口,绑定在可配置的地址与端口(默认 0.0.0.0 + 可配置端口)上,使下游(如 Python)可将该固定地址直接设为 HTTP/SOCKS 代理。流经该入口的流量 MUST 被转发到当前最健康(得分最低、可用)的节点。该代理地址 MUST 在节点变化与订阅刷新期间保持不变。

#### Scenario: 流量经固定入口走最优节点
- **WHEN** 下游将代理设为该固定地址并发起请求,且存在可用节点
- **THEN** 请求经服务转发,通过当前 best 节点出网

#### Scenario: best 节点变化对下游透明
- **WHEN** 当前 best 节点发生变化
- **THEN** 下游仍使用同一个固定代理地址,新建立的连接自动经新的 best 节点出网,无需下游变更配置

### Requirement: 基于评分的 best 节点热切换
服务 MUST 在 best 节点变化时,通过 sing-box 的运行时控制接口(Clash API)将代理选择(selector)切换到当前 best 节点对应的出站,而 MUST NOT 因 best 切换重启 sing-box 进程。best 的判定 MUST 复用既有的健康评分与可用性定义(lastCheck>0 且 failCount===0 且非死亡中得分最低者)。

#### Scenario: best 切换不重启进程
- **WHEN** best 节点从节点 A 变为节点 B
- **THEN** 服务通过 Clash API 把 selector 选为 B 的出站,sing-box 进程不重启

### Requirement: 节点更新期间代理高可用
节点集发生更新(订阅刷新或节点集重建)时,对外代理入口 MUST 保持可用,不得出现因 sing-box 重建/重启导致的代理端口不可用窗口。服务 MUST 采用稳定前置转发层 + 双实例切换:用新节点集启动新的 sing-box 实例,待其就绪后再将前置转发层的上游原子切换到新实例,然后排空并关闭旧实例。前置转发层 MUST NOT 随 sing-box 实例的重建而中断。

#### Scenario: 节点集更新时代理不中断
- **WHEN** 因订阅刷新导致节点集更新,服务重建 sing-box 实例
- **THEN** 对外代理入口在整个切换过程中保持监听与可转发,不出现不可用窗口

#### Scenario: 新实例就绪后才切换上游
- **WHEN** 新 sing-box 实例尚未就绪
- **THEN** 前置转发层仍指向旧实例;仅在新实例就绪后才把上游切到新实例,并随后关闭旧实例

### Requirement: 切换不中断已建立连接
best 节点切换与节点集更新切换 MUST NOT 中断已经建立的代理连接。best 切换(selector)MUST 配置为不中断既有连接(`interrupt_exist_connections: false`),仅新连接走新 best。节点集更新的蓝绿切换 MUST 采用优雅排空:切换后新连接走新实例,已建立的旧连接保持连到旧实例继续传输,旧实例 MUST 在其连接排空后或到达可配置的最大排空超时后才关闭。

#### Scenario: best 切换不影响进行中的下载
- **WHEN** 某下游连接正在通过节点 A 传输数据,此时 best 从 A 切换到 B
- **THEN** 该连接继续通过 A 完成,不被中断;此后新建立的连接才走 B

#### Scenario: 蓝绿切换优雅排空旧连接
- **WHEN** 节点集更新触发蓝绿切换,且旧实例上仍有进行中的连接
- **THEN** relay 把新连接导向新实例,旧连接保持在旧实例继续传输,旧实例在连接排空或达到最大排空超时后才被关闭

### Requirement: 查询稳定代理地址 API
服务 SHALL 提供 `GET /proxy` 接口,返回稳定的对外代理地址以及当前 best 节点的信息(含完整节点信息)。当前没有任何可用节点时,接口 MUST 返回表示「当前无可用代理」的明确响应。

#### Scenario: 返回代理地址与 best 信息
- **WHEN** 客户端请求 `GET /proxy` 且存在可用节点
- **THEN** 服务返回固定代理地址与当前 best 节点的完整信息

#### Scenario: 无可用节点时的响应
- **WHEN** 当前没有任何可用节点
- **THEN** 服务返回表示「当前无可用代理」的明确响应,而非任意节点地址

