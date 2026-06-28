---
comet_change: add-best-proxy-gateway
role: technical-design
canonical_spec: openspec
archived-with: 2026-06-28-add-best-proxy-gateway
status: final
---

# Best Proxy Gateway — 技术设计

OpenSpec delta spec(`openspec/changes/add-best-proxy-gateway/specs/{node-health-monitor,best-proxy-gateway}/spec.md`)是需求事实源。本文件描述 HOW:架构、数据流、关键算法、测试。建立在已归档的 node-health-monitor 实现之上。

## 1. 架构与模块边界

```
src/
  config.ts          新增配置项(见 §7)
  types.ts           Node + originalUri;NodeView + raw + originalUri
  subscription/parsers/{trojan,vmess,ss,vless}.ts  解析时保存 originalUri
  singbox/
    ports.ts         [新] allocatePorts:端口可用性探测 + 按可用分配(跳过占用/排除集)
    config.ts        buildConfig:per-node 检查入站 + 固定 in-proxy + selector + block + clash_api
    process.ts       SingBoxInstance:start/ready/stop(单实例封装,带 clash 端口与 proxy 入站端口)
    clash.ts         [新] ClashClient:setSelector(name,outbound) / waitReady()
    orchestrator.ts  [新] InstanceOrchestrator:active 实例 + blueGreenSwap(newNodes)
  relay.ts           [新] TcpRelay:监听 PROXY_PORT,透明转发到 activeUpstreamPort,setUpstream 原子切换 + 优雅排空
  scoring.ts         不变
  store/state-store.ts  不变
  monitor.ts         best 变化→clash.setSelector;节点集变化→orchestrator.blueGreenSwap
  api.ts             /nodes /nodes/best 补全 raw+originalUri;新增 GET /proxy
  index.ts           装配 relay + orchestrator + clash 生命周期
```

依赖方向:`index → {config, store, monitor, api, relay, orchestrator}`;`orchestrator → {singbox/process, singbox/config, clash, relay}`;`relay`、`clash`、`ports` 自包含,便于单测注入。

## 2. Req1 — 完整节点信息

- `Node` 增加 `originalUri: string`,四个 parser 在返回 Node 时填入原始 URI 行。
- `NodeView` 增加 `raw: Record<string, unknown>` 与 `originalUri: string`。
- `api.ts` 构造 NodeView 时,从 monitor 内存中的 `Node`(已含 raw / originalUri)取这两个字段;Redis 仍只存既有 NodeState,不持久化 raw。
- `/nodes`、`/nodes/best`、`/proxy` 返回的节点对象统一带 raw + originalUri。

## 3. Req2 — 端口跳过分配

`singbox/ports.ts`:
```
async function isPortFree(port, host='127.0.0.1'): Promise<boolean>
  // 尝试 Bun.listen({hostname,port}) 成功即空闲,立即 close;EADDRINUSE → 占用
async function allocatePorts(count, startPort, exclude:Set<number>): Promise<number[]>
  // 从 startPort 起,跳过 exclude 与已占用端口,收集 count 个空闲端口
```
- `buildConfig` 改为接收已分配好的端口(或内部调用 allocatePorts),`portMap` 记录每个 key 的实际端口。
- 蓝绿:新实例分配端口时把旧实例占用端口加入 `exclude`。
- TOCTOU 兜底:`SingBoxInstance.start` 若因端口竞争退出,从更高的 startPort 段重试一次(有限次)。

## 4. Req3 — 转发代理(selector + Clash API)

### sing-box 配置(单实例,buildConfig 产出)
- outbounds:每节点 `{type:<proto>, tag:'out-<key>', ...}`;`{type:'selector', tag:'proxy-select', outbounds:[所有 out-<key>], interrupt_exist_connections:false}`;`{type:'block', tag:'block'}`。
- inbounds:每节点 `{type:'mixed', tag:'in-<key>', listen:'127.0.0.1', listen_port:<分配口>}`;固定 `{type:'mixed', tag:'in-proxy', listen:'127.0.0.1', listen_port:<内部 proxy 口>}`。
- route.rules:`in-<key> → out-<key>`;`in-proxy → proxy-select`。
- experimental.clash_api:`{external_controller:'127.0.0.1:<clash 口>', secret:'<secret>'}`。

注:`in-proxy` 监听内部 127.0.0.1 口,对外由 relay 暴露;每实例 clash 口、proxy 口、检查口都在该实例端口段内。

### ClashClient(`singbox/clash.ts`)
- `setSelector(outboundTag)`:`PUT http://127.0.0.1:<clash口>/proxies/proxy-select` body `{"name":outboundTag}`,带 `Authorization: Bearer <secret>`。
- `waitReady(timeoutMs)`:轮询 `GET /` 直到 2xx 或超时。

### best 切换(monitor)
- monitor 维护 `currentBestKey`。每轮检查后计算 best(复用 scoring + 可用定义)。
- best key 变化 → `clash.setSelector('out-<bestKey>')`;无可用节点 → `clash.setSelector('block')`。
- 仅在变化时调用,避免抖动。

## 5. Req3-HA — TCP relay + 蓝绿

### TcpRelay(`relay.ts`)
- `Bun.listen({hostname:proxyBindAddress, port:PROXY_PORT, socket:{...}})`,常驻,永不随 sing-box 重启。
- 持有可变 `activeUpstreamPort`。每条新入站连接:读当前 `activeUpstreamPort` 快照 → `Bun.connect` 到 `127.0.0.1:upstream` → 双向 pipe(透明 TCP)。
- `setUpstream(port)`:更新 `activeUpstreamPort`;**不影响已建立的 pipe**(它们已绑定旧 upstream)→ 旧连接保留。
- 记录每条连接归属的实例,供蓝绿排空判断。

### InstanceOrchestrator(`singbox/orchestrator.ts`)
- 持有 `active: SingBoxInstance`。
- `blueGreenSwap(newNodes)`:
  1. `exclude` = active 实例占用端口;`allocatePorts` 给新实例 → `buildConfig` → 新 `SingBoxInstance.start()`。
  2. `await newInstance.ready()`(clash.waitReady + TCP 连 in-proxy 口)。失败 → 弃用新实例、保留旧实例、告警返回。
  3. monitor.portMap ← 新实例检查口;clash ← 新实例;`setSelector(当前 best 或 block)`。
  4. `relay.setUpstream(新实例 in-proxy 口)`(原子切换)。
  5. 旧实例优雅排空:停止接收新连接(relay 已不再导向它),等其残留连接自然结束;到 `MAX_DRAIN_SECONDS`(默认 300)仍未排空 → `oldInstance.stop()` 硬关。
- best 切换不走这里(只 clash.setSelector)。

### 触发
- monitor 的订阅刷新(节点集变化)→ `orchestrator.blueGreenSwap(newNodes)`,替换原 `singbox.restart` 路径。集合未变则不 swap。

## 6. GET /proxy
- 计算当前 best(同 /nodes/best)。
- 有 best → `{ proxy: "http://<host>:<PROXY_PORT>", node: <best 完整 NodeView> }`。
- 无可用节点 → `{ proxy: null, node: null }`(此时 selector 已指向 block,代理连接立即拒绝)。
- `<host>` 取配置的对外 host(或请求 Host 头),`<PROXY_PORT>` 为 relay 对外端口。

## 7. 配置(.env → config.ts)

| 变量 | 默认 | 说明 |
|------|------|------|
| `PROXY_PORT` | 8080 | relay 对外代理端口 |
| `PROXY_BIND_ADDRESS` | 0.0.0.0 | relay 绑定地址 |
| `PROXY_PUBLIC_HOST` | (请求 Host 兜底) | /proxy 返回地址用的对外 host |
| `CLASH_API_BASE_PORT` | 9090 | clash 控制口基址(蓝/绿各偏移)|
| `CLASH_API_SECRET` | (随机/必填) | clash 鉴权 secret |
| `SINGBOX_INSTANCE_PORT_STRIDE` | 1000 | 蓝绿两实例端口段间隔 |
| `SINGBOX_PROXY_INBOUND_OFFSET` | 0 | 实例内 in-proxy 端口偏移 |
| `MAX_DRAIN_SECONDS` | 300 | 旧实例最大排空超时 |
| `INSTANCE_READY_TIMEOUT_MS` | 8000 | 新实例就绪探测超时 |

(沿用既有:SUBSCRIPTION_URL、CHECK_INTERVAL_SECONDS、MAX_CONCURRENCY、REFRESH_*、NODE_TTL_SECONDS、DEATH_THRESHOLD、REVIVAL_SECONDS、TEST_URL、PROBE_TIMEOUT_MS、SINGBOX_BASE_PORT、SINGBOX_BIN、REDIS_URL。)

## 8. 测试策略

- **纯逻辑单测**:NodeView 补全(raw+originalUri)、parser 保存 originalUri、`ports.allocatePorts`(跳过占用 + 排除集)、`buildConfig`(selector/block/in-proxy/clash_api JSON)、`ClashClient.setSelector`(对 mock HTTP server 断言请求)。
- **relay 单测**:本地 echo TCP 上游 A/B;验证透明转发、`setUpstream` 后新连接走 B、已建立连接仍走 A(保留)。
- **orchestrator 单测**:mock SingBoxInstance(start/ready/stop)+ mock relay;验证就绪后才 setUpstream、就绪失败保留旧实例、优雅排空与 300s 超时硬关。
- **monitor 单测**:mock clash 客户端;验证 best 变触发 setSelector、无可用→block、节点集变触发 blueGreenSwap、集合未变不 swap。
- **StateStore**:沿用既有真实 redis 集成测。
- **e2e 冒烟**(非阻塞):真实 sing-box,Python 经固定代理出网,触发刷新期间代理不中断。

## 9. 风险与缓解

- [单实例蓝绿瞬间 ~2N 检查入站端口并存] → 刷新不频繁,transient;端口段可配;必要时后续拆 checker/proxy(本期不做)。
- [端口 TOCTOU] → 探测 + 启动失败重试更高端口段。
- [长连接钉在旧实例 / 旧节点] → 稳定性优先;>300s 蓝绿超长连接会被截断(可配)。
- [relay 透明 TCP 能否承载代理协议] → mixed 入站对客户端是标准 HTTP/SOCKS,TCP 层透明即可。
- [代理端口无鉴权对外暴露] → 部署/网络层负责;Clash API 仅 127.0.0.1 + secret。
- [新实例就绪失败] → 保留旧实例继续服务,告警,下轮再试。
