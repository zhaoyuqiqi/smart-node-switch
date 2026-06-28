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
