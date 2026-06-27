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
