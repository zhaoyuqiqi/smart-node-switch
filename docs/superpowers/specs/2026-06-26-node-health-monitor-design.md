---
comet_change: add-node-health-monitor
role: technical-design
canonical_spec: openspec
archived-with: 2026-06-27-add-node-health-monitor
status: final
---

# Node Health Monitor — 技术设计

OpenSpec delta spec(`openspec/changes/add-node-health-monitor/specs/node-health-monitor/spec.md`)是需求事实源。本文件只描述 HOW:架构、数据流、关键算法、测试。

## 1. 架构与模块边界

每个模块单一职责,通过明确接口通信,可独立测试。

```
src/
  index.ts              入口:load config → 建 store/monitor → 启动 → 挂 Elysia 路由 → 生命周期
  config.ts             从 .env 读取并校验配置(含默认值),导出 Config
  types.ts              Node / NodeState / NodeView / Config 类型
  subscription/
    fetch.ts            fetchSubscription(url): Promise<string>(拉取 + base64 解码 → 原始行)
    parsers/trojan.ts   parseTrojan(uri): Node | null
    parsers/vmess.ts    parseVmess(uri): Node | null
    parsers/ss.ts       parseSs(uri): Node | null      (SIP002 与 base64 变体)
    parsers/vless.ts    parseVless(uri): Node | null
    parse.ts            parseSubscription(text): Node[](分发到 parser,跳过非法,生成 nodeKey)
  singbox/
    outbound.ts         toOutbound(node): object(Node → sing-box outbound JSON,4 协议)
    config.ts           buildConfig(nodes, basePort): { config, portMap }
    process.ts          SingBoxProcess:start/restart/stop(常驻子进程)
    probe.ts            probe(proxyPort, testUrl, timeoutMs): Promise<ProbeResult>
  store/
    state-store.ts      StateStore 接口 + RedisStateStore(ioredis)实现
  scoring.ts            score(state, now): number(纯函数)
  monitor.ts            Monitor:周期调度 + p-queue 并发 + 死亡复活 + 刷新触发
  api.ts                注册 GET /nodes、GET /nodes/best 到 Elysia 实例
```

依赖方向:`index → {config, store, monitor, api}`;`monitor → {store, singbox, scoring, subscription}`;`singbox/subscription/scoring/store` 互不依赖。probe 与 StateStore 作为接口注入 monitor,便于测试替换。

## 2. 数据模型

### 内部 Node(连接身份,来自订阅解析)
```ts
interface Node {
  key: string;        // 连接身份哈希:sha1(`${protocol}|${server}|${port}|${credential}|${transportParams}`).slice(0,16)
  name: string;       // 展示名(URI #fragment),仅展示,不参与 key
  protocol: 'trojan' | 'vmess' | 'ss' | 'vless';
  server: string;
  port: number;
  raw: Record<string, unknown>; // 协议特定字段,供 toOutbound 使用
}
```

### NodeState(Redis,key = `node:<key>` 的 hash)
```ts
interface NodeState {
  latency: number;      // 最近一次成功的延迟 ms(失败不更新)
  failCount: number;    // 连续失败次数;一次成功归 0
  successCount: number; // 累计成功次数(观测用)
  lastCheck: number;    // 最近一次检查时间戳 ms;从未检查=0(字段缺失视为 0)
  // 展示冗余:name/protocol/server/port(避免查询时再解析)
}
```
- 死亡标记:独立 key `dead:<key>`,值任意,TTL = revivalSeconds(默认 24h)。
- TTL 治理:每次写 `node:<key>` 后 `EXPIRE node:<key> nodeTtlSeconds`(默认 2 天,即 172800);每次读操作也续期(读后 EXPIRE)。

## 3. sing-box 编排(单实例 · 一节点一端口)

`buildConfig(nodes, basePort)`:
- 对第 i 个节点,分配 `port = basePort + i`,生成:
  - inbound:`{ type:'mixed', tag:'in-'+key, listen:'127.0.0.1', listen_port:port }`
  - outbound:`toOutbound(node)`,tag = `'out-'+key`
  - route rule:`{ inbound:['in-'+key], outbound:'out-'+key }`
- 返回 `{ config, portMap: Map<key, port> }`。
- `toOutbound` 按协议映射(trojan/vmess/shadowsocks/vless 对应 sing-box outbound type 与字段)。

`SingBoxProcess`:
- `start(configPath)`:写 config 到临时文件,`spawn(SINGBOX_BIN, ['run','-c',configPath])`,等待端口就绪(轮询任一端口可连或固定短暂延时)。
- `restart(nodes)`:订阅刷新后,stop → 重新 buildConfig → start。
- `stop()`:kill 子进程。

健康检查通过 `portMap` 拿到节点本地端口 → `probe`。

## 4. probe(经代理探测)

```ts
async function probe(port, testUrl, timeoutMs): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const res = await fetch(testUrl, {
      proxy: `http://127.0.0.1:${port}`,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - start;
    return { ok: res.status > 0 && res.status < 400, latencyMs };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}
```
- 利用 Bun `fetch` 的 `proxy` 选项走本地 mixed 口。
- 默认 testUrl = `http://www.gstatic.com/generate_204`(返回 204);成功判定 `status < 400`。
- 超时记失败。probe 作为可注入函数,monitor 测试时用 mock 替换。

## 5. 评分(纯函数)

```ts
function score(s: NodeState, now: number): number {
  return s.latency * 0.7 + s.failCount * 100 + (now - s.lastCheck) * 0.001;
}
```
- 越低越健康。failCount 权重 100 → 成功率主导(成功率优先于延迟)。
- 仅对可用节点计算(可用节点 lastCheck>0,(now-lastCheck) 有意义)。

## 6. 调度与状态机(monitor)

`runRound()`:
1. 读取全部节点(内存维护当前 Node[],来自最近一次订阅解析)。
2. 过滤掉 dead(`EXISTS dead:<key>`)节点。
3. 其余节点入 p-queue(concurrency 默认 10),每个执行:
   - `r = await probe(portMap[key], testUrl, timeoutMs)`
   - 成功:`state.latency=r.latencyMs; state.failCount=0; state.successCount++; state.lastCheck=now` → 写入并续期。
   - 失败:`state.failCount++; state.lastCheck=now` → 写入并续期;若 `failCount >= deathThreshold(默认20)` → 写 `dead:<key>`(TTL=revivalSeconds)。
4. 等队列排空(一轮完成)。
5. 评估刷新:`available = nodes.filter(lastCheck>0 && failCount===0).length`;若 `available < total * refreshThreshold(默认0.1)` 且距上次刷新超过 `refreshCooldownSeconds` → `refreshSubscription()`(重新 fetch+parse+restart sing-box)→ 立即再 `runRound()` 一次。

调度循环:启动即 `runRound()`,之后每 `intervalSeconds`(默认30)一轮。

### 死亡/复活语义
- failCount 持续累加,不在标记 dead 时清零。
- dead 节点:`failCount >= 20` 天然不可用;被 runRound 跳过。
- 复活:`dead:<key>` TTL 到期(Redis 自动删)→ 节点重新进入检查集。
- 复活后:一次成功 → failCount=0 → 可用;一次失败(failCount 仍 ≥20)→ 立即重写 dead key。无需重新累计 20 次。

## 7. API(api.ts)

可用集 = `nodes` 中 `state.lastCheck > 0 && state.failCount === 0 && !dead`。

- `GET /nodes` → `{ count: number, nodes: NodeView[] }`,NodeView = `{ key, name, protocol, server, port, latency, failCount, lastCheck, score }`。
- `GET /nodes/best` → 可用集中 `score` 最低的 NodeView;可用集为空 → `{ best: null }`(HTTP 200,明确表达无可用节点)。

## 8. 配置(.env → config.ts)

| 变量 | 默认 | 说明 |
|------|------|------|
| `SUBSCRIPTION_URL` | (必填) | 订阅地址 |
| `CHECK_INTERVAL_SECONDS` | 30 | 检查周期 |
| `MAX_CONCURRENCY` | 10 | p-queue 并发 |
| `REFRESH_THRESHOLD` | 0.1 | 可用占比低于此触发刷新 |
| `REFRESH_COOLDOWN_SECONDS` | 300 | 两次订阅刷新最小间隔 |
| `NODE_TTL_SECONDS` | 172800 | 节点 state key TTL(2 天)|
| `DEATH_THRESHOLD` | 20 | 连续失败死亡阈值 |
| `REVIVAL_SECONDS` | 86400 | 死亡复活时长(24h)|
| `TEST_URL` | http://www.gstatic.com/generate_204 | 探测目标 |
| `PROBE_TIMEOUT_MS` | 5000 | 单次探测超时 |
| `SINGBOX_BASE_PORT` | 30000 | 本地 inbound 起始端口 |
| `SINGBOX_BIN` | src/sing-box/sing-box | 二进制路径 |
| `REDIS_URL` | redis://127.0.0.1:6379 | Redis 连接 |

## 9. 测试策略

- **纯逻辑单测(bun test)**:
  - parsers:每协议给样例 URI(含变体)→ 断言 Node 字段;非法输入 → null。
  - parseSubscription:base64 解码 + 跳过非法 + nodeKey 稳定性/去重。
  - scoring:公式正确性、failCount 主导。
  - toOutbound:每协议 → 期望 sing-box outbound JSON。
  - 死亡/复活状态转移(以 StateStore 为依赖)。
- **StateStore 真实 redis 集成测**:独立 DB index;覆盖写入设 TTL、操作续期、dead key 24h、复活后行为。
- **monitor 调度测**:注入 mock probe(可编排成功/失败序列),验证 failCount 归零、死亡触发、刷新触发(占比<10%)、并发不超上限。
- **e2e 冒烟**:真实订阅 + sing-box,断言能解析出节点、API 返回结构正确(网络相关,作为非阻塞冒烟)。

## 10. 风险与缓解

- [一节点一端口,节点多时监听口多] → basePort 可配;sing-box 可承受;必要时后续分批(本期不做)。
- [sing-box 二进制 darwin/amd64] → 本机可用;生产需匹配架构二进制(运行前提)。
- [Bun fetch proxy 行为差异] → probe 收口,e2e 冒烟验证真实路径。
- [Redis 不可用] → 状态周期可重建;连接失败时启动报错并退出(明确失败优于静默降级)。
- [持续低可用反复刷新订阅] → refreshCooldownSeconds 防抖。
