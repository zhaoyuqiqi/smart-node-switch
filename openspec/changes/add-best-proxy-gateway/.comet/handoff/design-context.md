# Comet Design Handoff

- Change: add-best-proxy-gateway
- Phase: design
- Mode: compact
- Context hash: 347b8634fcef91661d2545939d4b0322d42dddf211d30e3dfcb659e6309bd5b9

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/add-best-proxy-gateway/proposal.md

- Source: openspec/changes/add-best-proxy-gateway/proposal.md
- Lines: 1-27
- SHA256: a9aff1b311faa82409ca7b8da1a3a56ab6e476d7db22122ca3d7a0318cba3015

```md
## Why

node-health-monitor 已能挑出最健康节点,但有三个缺口:(1) 健康接口返回的节点信息不完整,丢失了协议细节等订阅原始信息,调用方无法据此使用节点;(2) sing-box 在起始端口段被占用时直接启动失败,健壮性不足;(3) 缺少一个可供下游(如 Python)直接当代理使用的稳定入口——目前只有每节点的本地端口,地址会变且仅同机可达。本变更补齐这三点,并保证代理转发在节点更新期间高可用。

## What Changes

- **节点信息补全(Req1)**:健康查询接口(`GET /nodes`、`GET /nodes/best`)返回的节点对象补全为完整信息——包含 `Node.raw`(协议特定字段:password/sni/type/uuid/传输参数等)与原始订阅信息(原始 URI)。数据取自 monitor 内存中的 `Node`,无需在 Redis 额外持久化 raw。
- **sing-box 端口跳过(Req2)**:分配本地监听端口时探测端口可用性,跳过已被占用的端口,取下一个空闲端口;`portMap` 记录实际分配端口。被占用端口不再导致 sing-box 启动失败。
- **最优节点转发代理网关(Req3)**:服务对外提供一个**固定**的转发代理(Docker 暴露,0.0.0.0 绑定)。下游把代理地址设为该固定地址,流量经服务转发到当前最健康节点。内部用 sing-box `selector` 出站 + Clash API 在运行时把 selector 热切到当前 best 节点(不重启)。新增 `GET /proxy` 返回稳定代理地址与当前 best 节点信息。
- **代理转发高可用(Req3-HA)**:节点集更新(订阅刷新/重建)时,对外代理端口**不中断**。机制为稳定 TCP relay 前置 + sing-box 蓝绿双实例:用新节点集启动新实例,就绪后把 relay 上游原子切到新实例,再排空/关闭旧实例。relay 自身常驻、永不随 sing-box 重启。

## Capabilities

### New Capabilities
- `best-proxy-gateway`: 对外固定转发代理入口、基于健康评分的 best 节点 selector 热切换、节点集更新期间经 TCP relay + 蓝绿双实例保持代理高可用,以及 `GET /proxy` 稳定代理地址查询。

### Modified Capabilities
- `node-health-monitor`: 查询接口返回的节点对象补全为完整节点信息(raw + 原始 URI);sing-box 本地端口分配支持跳过被占用端口。

## Impact

- **新增能力/模块**:TCP relay(透明 TCP 转发,常驻对外端口)、sing-box 蓝绿实例编排、Clash API 客户端(切 selector)、proxy 网关路由。
- **改动现有代码**:`types.ts`(NodeView 扩展)、`api.ts`(返回完整信息 + `/proxy`)、`singbox/config.ts`(端口跳过 + 固定 proxy 入站 + selector + clash_api 配置)、`singbox/process.ts`(蓝绿双实例)、`monitor.ts`(best 变化驱动 selector 切换、节点集更新驱动蓝绿)、`config.ts`(新增 PROXY_PORT、Clash API 控制端口/secret、relay/实例端口段、bind 地址)、`index.ts`(接入 relay 与代理生命周期)。
- **外部依赖**:不新增 npm 依赖;复用内置 sing-box(`with_clash_api`)。运行时 Docker 暴露代理端口与管理 API 端口两个端口。
- **配置**:PROXY_PORT、Clash API 端口与 secret、sing-box 实例端口段(蓝绿需两套且与节点检查端口不冲突)、relay 排空策略等通过 .env 提供。
- **安全**:代理端口对外暴露,本期不做鉴权,暴露面安全由部署/网络层负责(design 记风险)。
- **非目标**:不改评分公式、死亡/复活、TTL、刷新等既有逻辑;不新增协议支持;不做鉴权。
```

## openspec/changes/add-best-proxy-gateway/design.md

- Source: openspec/changes/add-best-proxy-gateway/design.md
- Lines: 1-47
- SHA256: eee96ed76dce0cee5831d66e203459e293344ee618a47b31f167eaa3b3a3be24

```md
## Context

在已归档的 node-health-monitor 之上增强:补全节点信息、sing-box 端口健壮性、新增对外固定转发代理网关,并保证代理在节点更新期间高可用。运行时仍为 Bun + Elysia + ioredis + 内置 sing-box(带 `with_clash_api`)。部署在 Docker,代理端口与管理 API 端口两个都对外暴露(0.0.0.0)。

本文件给出高层架构与选型;line-by-line 实现与 TDD 计划在 `/comet-design` 深度设计阶段产出。

## Goals / Non-Goals

**Goals:**
- 健康查询接口返回完整节点信息(`Node.raw` + 原始 URI)。
- sing-box 本地端口分配跳过被占用端口,占用不再导致启动失败。
- 对外一个固定转发代理地址(Docker 暴露),流量经服务转发到当前 best 节点;best 切换用 Clash API 热切 selector。
- 节点集更新时代理对外端口不中断(TCP relay + 蓝绿双实例)。
- 新增 `GET /proxy` 返回稳定代理地址 + 当前 best 信息。

**Non-Goals:**
- 不改评分公式、死亡/复活、TTL、刷新等既有逻辑。
- 不新增协议支持。
- 不做代理鉴权(暴露面安全交部署/网络层)。
- relay 不自实现 HTTP/SOCKS 代理语义,只做透明 TCP 转发,真正代理仍由 sing-box 承担。

## Decisions

- **Req1 信息补全**:扩展 `NodeView`,新增 `raw`(协议特定字段)与原始 URI 字段。数据来自 monitor 内存中的 `Node`(已含 raw),api.ts 已 join,无需在 Redis 持久化 raw。为保留原始 URI,解析时在 `Node` 上保存 `originalUri`。
- **Req2 端口跳过**:端口分配从"`basePort+i` 连号"改为"按可用性分配":对候选端口尝试绑定(127.0.0.1)探测占用,占用则跳到下一个空闲端口;`portMap` 记录实际端口。蓝绿期间还需避开另一实例已占用端口。承认存在 TOCTOU(探测到空闲与 sing-box 实际绑定间被抢占),用"启动失败后重试下一段端口"兜底。
- **Req3 转发代理(A1)**:sing-box 配置新增一个固定 `mixed` 入站(`in-proxy`)+ 一个 `selector` 出站(`proxy-select`,成员为全部节点 outbound);route `in-proxy → proxy-select`。启用 `experimental.clash_api`(本地控制端口 + secret)。monitor 在 best 变化时调用 Clash API 把 `proxy-select` 选为 best 的 `out-<key>`(热切,不重启)。
- **Req3-HA 蓝绿 + relay**:对外代理端口由常驻 **Bun TCP relay** 持有(0.0.0.0:PROXY_PORT,永不随 sing-box 重启)。relay 透明转发到"当前活跃 sing-box 实例"的内部 proxy 入站端口。节点集更新流程:用新节点集 build 新实例(端口段错开)→ 起新实例 → 就绪探测 → 原子切换 relay 上游 → 排空/关闭旧实例。best 节点切换仍走 Clash API,不触发蓝绿。
- **切换不中断已建立连接(稳定性保证)**:两层切换都 MUST 保持进行中的连接不被切断。(1) selector 出站设 `interrupt_exist_connections: false`(默认),best 切换只影响新连接,已建立连接保持在原节点出站直到结束;(2) relay 蓝绿切换采用优雅排空:切换上游后,新连接走新实例,已建立的旧连接保持连到旧实例继续传输,旧实例待其连接排空后(或到达可配置的最大排空超时)再关闭。代价:长连接会"钉"在开始时的节点/实例上,享受不到后续切换收益;唯一中断情形是旧节点物理掉线或超长连接触达最大排空超时。
- **GET /proxy**:返回 `{ proxy: "http://<host>:<PROXY_PORT>", node: <best NodeView 含完整信息> }`;无可用节点时返回明确的无代理响应。
- **配置(.env)**:PROXY_PORT、proxyBindAddress、Clash API 端口与 secret、sing-box 两套实例端口段(蓝/绿)、relay 排空策略与超时等。

## Risks / Trade-offs

- [蓝绿双实例使端口/内存占用翻倍] → 仅切换瞬间双实例并存,切换后即排空旧实例;端口段可配。
- [端口探测 TOCTOU] → 探测 + 启动失败重试下一段端口兜底。
- [relay 透明 TCP 能否承载 HTTP/SOCKS] → mixed 入站对客户端是标准代理协议,TCP 层透明转发即可,客户端无感。
- [代理端口对外暴露无鉴权] → design 阶段记安全风险,建议部署侧用网络策略限制;本期不做鉴权。
- [Clash API 控制口暴露] → 仅绑 127.0.0.1 + secret,不对外。
- [best 频繁切换导致 selector 抖动] → 复用既有评分,必要时加切换防抖(深度设计定)。

## Open Questions

- relay 上游切换的原子性实现细节(新连接走新实例,旧连接保持的具体数据结构)。
- best 切换防抖阈值。
- 最大排空超时的默认取值。
- sing-box 实例"就绪"判定(端口可连 vs Clash API ready)。
- 无可用节点时:relay/selector 的具体降级行为(拒绝连接 vs 挂起)。
```

## openspec/changes/add-best-proxy-gateway/tasks.md

- Source: openspec/changes/add-best-proxy-gateway/tasks.md
- Lines: 1-38
- SHA256: 58c0e0c3ebfb68eb57225f0e980d745c2a1c45a8a0fa633d2cbc9bded30d951e

```md
## 1. 配置与类型

- [ ] 1.1 config 新增:PROXY_PORT、proxyBindAddress、Clash API 端口/secret、sing-box 蓝绿两套实例端口段、relay 排空策略/超时(含单测)
- [ ] 1.2 类型扩展:`Node` 增加 `originalUri`;`NodeView` 增加 `raw` 与 `originalUri`

## 2. Req1 节点信息补全

- [ ] 2.1 解析器在 `Node` 上保存 `originalUri`(四协议,含单测)
- [ ] 2.2 `api.ts` 的 `/nodes` 与 `/nodes/best` 返回补全 raw + originalUri(含单测)

## 3. Req2 端口跳过

- [ ] 3.1 实现端口可用性探测(尝试绑定 127.0.0.1:port,占用则跳过)（含单测）
- [ ] 3.2 `buildConfig` 端口分配改为按可用性分配,跳过占用端口、记录实际 portMap;支持避开排除端口集(蓝绿用)（含单测）
- [ ] 3.3 sing-box 启动失败(端口竞争)时回退重试下一段端口

## 4. Req3 转发代理(selector + Clash API)

- [ ] 4.1 `buildConfig` 增加固定 proxy 入站(mixed,bind 可配)+ selector 出站(成员=全部节点 outbound,`interrupt_exist_connections: false`)+ route 规则 + 启用 clash_api(含单测)
- [ ] 4.2 实现 Clash API 客户端:把 selector 切到指定 outbound(含单测,可对 mock HTTP)
- [ ] 4.3 monitor 在 best 变化时调用 Clash API 热切 selector(不重启)（含单测,mock clash 客户端）

## 5. Req3-HA TCP relay + 蓝绿双实例

- [ ] 5.1 实现常驻 Bun TCP relay:监听对外 PROXY_PORT,透明转发到当前活跃上游端口,支持原子切换上游;切换时保留已建立连接、仅新连接走新上游(含单测,可用本地 echo TCP 服务)
- [ ] 5.2 实现 sing-box 实例"就绪"探测(端口可连 / Clash API ready)
- [ ] 5.3 蓝绿编排:节点集更新时起新实例→就绪→切 relay 上游→优雅排空(保留旧连接,达最大排空超时才硬关)→关闭旧实例(含单测,mock 实例与 relay)
- [ ] 5.4 monitor 的订阅刷新接入蓝绿编排,替换原 restart 路径

## 6. /proxy API 与装配

- [ ] 6.1 实现 `GET /proxy`:返回固定代理地址 + 当前 best 完整信息;无可用节点时明确响应(含单测)
- [ ] 6.2 `index.ts` 接入 relay、蓝绿编排、Clash API 客户端的生命周期

## 7. 集成与收尾

- [ ] 7.1 端到端验证:起服务 → /nodes 含完整信息 → 占用部分端口仍启动 → Python 经固定代理出网 → 触发刷新代理不中断
- [ ] 7.2 更新 README:新增配置项、/proxy 用法、Python 代理示例、Docker 两端口暴露说明
```

## openspec/changes/add-best-proxy-gateway/specs/best-proxy-gateway/spec.md

- Source: openspec/changes/add-best-proxy-gateway/specs/best-proxy-gateway/spec.md
- Lines: 1-52
- SHA256: 6024cc6a72378aa8b85ba15e1bcca718439b58e55bc36b9e09c00fa42f0cf18c

```md
## ADDED Requirements

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
```

## openspec/changes/add-best-proxy-gateway/specs/node-health-monitor/spec.md

- Source: openspec/changes/add-best-proxy-gateway/specs/node-health-monitor/spec.md
- Lines: 1-23
- SHA256: 4b1425294409a3d03f46bd4a7ab7eb0181723f4bdb39d233166cb655ddbb54ec

```md
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
```

