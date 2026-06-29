---
change: add-best-proxy-gateway
design-doc: docs/superpowers/specs/2026-06-27-best-proxy-gateway-design.md
base-ref: 79c2bd7c41904827fafdbeb77ef97de89cc60f07
archived-with: 2026-06-28-add-best-proxy-gateway
---

# Best Proxy Gateway 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**目标：** 在已实现的 node-health-monitor 之上，补全节点信息查询、端口跳过分配，并提供一个稳定不中断的对外转发代理（selector 热切 + 蓝绿双实例 + 常驻 TCP relay）。

**架构：** sing-box 单实例新增固定 `mixed` in-proxy 入站 + 覆盖全部节点出站的 `selector` + `block` 出站 + `clash_api`；常驻 Bun TCP relay（`src/relay.ts`）对外监听 `PROXY_PORT`，透明转发到可变的活跃上游端口；`ClashClient`（`src/singbox/clash.ts`）热切 selector；`InstanceOrchestrator`（`src/singbox/orchestrator.ts`）做蓝绿换实例。monitor 在 best 变化时切 selector、在节点集变化时触发蓝绿。

**技术栈：** Bun + TypeScript、Elysia（HTTP API）、ioredis（StateStore，已存在）、p-queue（已存在）、sing-box（外部进程，selector + Clash API）、`Bun.listen` / `Bun.connect`（TCP relay）、`bun test`（测试）。

## Global Constraints

- 运行时统一用 Bun：`bun test` 跑测试，`bun <file>` 执行；不引入 node 专用替代库（保留已决策的 Elysia/ioredis/p-queue/sing-box）。
- 连接稳定性是硬性要求：best 切换（selector）与蓝绿换实例都 MUST NOT 中断已建立的连接。
- best 判定复用既有定义：`lastCheck > 0 && failCount === 0 && !dead`，在此集合内 `score()` 最低者；`score` 来自 `src/scoring.ts`，不改。
- Redis 只持久化既有 `NodeState`，不持久化 `raw` / `originalUri`；这两个字段从 monitor 内存中的 `Node` 取。
- 测试与源码同目录、`*.test.ts` 命名，用 `bun:test`（`describe/it/expect`）。relay/clash/orchestrator 用注入的 fake 做单测（echo TCP 上游 / mock HTTP / mock 实例）。
- 每个 task 结束即 commit；遇失败先加载 systematic-debugging，定位根因后再修。
- 设计细节以 Design Doc 为准（本计划按节引用，不复述）。`selector` 出站 MUST 带 `interrupt_exist_connections: false`。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## 文件结构

新建：

- `src/singbox/ports.ts` — 端口可用性探测 + 排除集分配（Req2）。
- `src/singbox/clash.ts` — Clash API 客户端：`setSelector` / `waitReady`（Req3）。
- `src/singbox/instance.ts` — `SingBoxInstance`：单实例封装（start/ready/stop，持有 clash 口、in-proxy 口、portMap）。
- `src/singbox/orchestrator.ts` — `InstanceOrchestrator`：蓝绿换实例。
- `src/relay.ts` — `TcpRelay`：常驻对外端口，透明转发，原子切上游 + 优雅排空。
- 各自的 `*.test.ts`。

修改：

- `src/types.ts` — `Node.originalUri`；`NodeView.raw` + `NodeView.originalUri`；`Config` 新增字段。
- `src/config.ts` — 加载 §7 新配置项。
- `src/subscription/parsers/{trojan,vmess,ss,vless}.ts` — 返回 `Node` 时填 `originalUri`。
- `src/singbox/config.ts` — `buildConfig` 改用 `allocatePorts`、加 in-proxy/selector/block/clash_api，返回更多端口信息。
- `src/api.ts` — `/nodes`、`/nodes/best` 补 `raw`+`originalUri`；新增 `GET /proxy`。
- `src/monitor.ts` — best 变化切 selector；节点集变化触发蓝绿；维护 `currentBestKey` 与 best 计算。
- `src/index.ts` — 装配 relay + orchestrator + clash 生命周期。
- `README.md` — 配置、`/proxy` 用法、Python 示例、Docker 两端口。

依赖顺序：Task 1（config/types）→ Task 2（Req1）→ Task 3（Req2 ports）→ Task 4（buildConfig selector/clash_api）→ Task 5（ClashClient）→ Task 6（relay）→ Task 7（SingBoxInstance + ready）→ Task 8（orchestrator 蓝绿）→ Task 9（monitor 切 selector + 触发蓝绿）→ Task 10（/proxy）→ Task 11（index 装配）→ Task 12（e2e + README）。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Task 1: 配置与类型扩展

实现 tasks.md §1.1 + §1.2。Design Doc §7 是配置事实源。

**Files:**
- Modify: `src/types.ts`（`Node`、`NodeView`、`Config`）
- Modify: `src/config.ts`（`loadConfig`）
- Test: `src/config.test.ts`（扩展）

**Interfaces:**
- Produces: `Node.originalUri: string`；`NodeView.raw: Record<string, unknown>` + `NodeView.originalUri: string`；`Config` 新增字段 `proxyPort: number`、`proxyBindAddress: string`、`proxyPublicHost: string`、`clashApiBasePort: number`、`clashApiSecret: string`、`singboxInstancePortStride: number`、`singboxProxyInboundOffset: number`、`maxDrainSeconds: number`、`instanceReadyTimeoutMs: number`。

- [x] **Step 1: 写失败测试 — 类型字段存在**

在 `src/config.test.ts` 末尾追加：

```typescript
import type { Node, NodeView } from './types.ts';

describe('extended types', () => {
  it('Node carries originalUri', () => {
    const n: Node = { key: 'k', name: 'n', protocol: 'trojan', server: 's', port: 443, raw: {}, originalUri: 'trojan://x' };
    expect(n.originalUri).toBe('trojan://x');
  });

  it('NodeView carries raw and originalUri', () => {
    const v: NodeView = {
      key: 'k', name: 'n', protocol: 'trojan', server: 's', port: 443,
      latency: 1, failCount: 0, lastCheck: 1, score: 1,
      raw: { password: 'p' }, originalUri: 'trojan://x',
    };
    expect(v.raw['password']).toBe('p');
    expect(v.originalUri).toBe('trojan://x');
  });
});
```

- [x] **Step 2: 写失败测试 — 新配置默认值与覆盖**

在 `src/config.test.ts` 的 `CONFIG_ENV_KEYS` 数组追加这些键，使 beforeEach 会清理它们：

```typescript
    'PROXY_PORT',
    'PROXY_BIND_ADDRESS',
    'PROXY_PUBLIC_HOST',
    'CLASH_API_BASE_PORT',
    'CLASH_API_SECRET',
    'SINGBOX_INSTANCE_PORT_STRIDE',
    'SINGBOX_PROXY_INBOUND_OFFSET',
    'MAX_DRAIN_SECONDS',
    'INSTANCE_READY_TIMEOUT_MS',
```

在 `loadConfig` 的 `describe` 内追加：

```typescript
  it('loads new proxy/clash defaults', () => {
    process.env['SUBSCRIPTION_URL'] = 'https://example.com/sub';
    const cfg = loadConfig();
    expect(cfg.proxyPort).toBe(8080);
    expect(cfg.proxyBindAddress).toBe('0.0.0.0');
    expect(cfg.proxyPublicHost).toBe('');
    expect(cfg.clashApiBasePort).toBe(9090);
    expect(typeof cfg.clashApiSecret).toBe('string');
    expect(cfg.clashApiSecret.length).toBeGreaterThan(0);
    expect(cfg.singboxInstancePortStride).toBe(1000);
    expect(cfg.singboxProxyInboundOffset).toBe(0);
    expect(cfg.maxDrainSeconds).toBe(300);
    expect(cfg.instanceReadyTimeoutMs).toBe(8000);
  });

  it('overrides new proxy/clash config from env', () => {
    process.env['SUBSCRIPTION_URL'] = 'https://example.com/sub';
    process.env['PROXY_PORT'] = '18080';
    process.env['CLASH_API_SECRET'] = 'fixed-secret';
    process.env['MAX_DRAIN_SECONDS'] = '60';
    const cfg = loadConfig();
    expect(cfg.proxyPort).toBe(18080);
    expect(cfg.clashApiSecret).toBe('fixed-secret');
    expect(cfg.maxDrainSeconds).toBe(60);
  });
```

- [x] **Step 3: 跑测试确认失败**

Run: `bun test src/config.test.ts`
Expected: FAIL（`proxyPort` 等字段不存在 / 类型属性缺失）。

- [x] **Step 4: 扩展类型**

在 `src/types.ts` 的 `Node` 接口加：

```typescript
  raw: Record<string, unknown>;
  originalUri: string;
```

在 `NodeView` 接口（`score: number;` 之后）加：

```typescript
  score: number;
  raw: Record<string, unknown>;
  originalUri: string;
```

在 `Config` 接口（`redisUrl: string;` 之后）加：

```typescript
  redisUrl: string;
  proxyPort: number;
  proxyBindAddress: string;
  proxyPublicHost: string;
  clashApiBasePort: number;
  clashApiSecret: string;
  singboxInstancePortStride: number;
  singboxProxyInboundOffset: number;
  maxDrainSeconds: number;
  instanceReadyTimeoutMs: number;
```

- [x] **Step 5: 实现 loadConfig**

在 `src/config.ts` 的返回对象（`redisUrl` 之后）加：

```typescript
    redisUrl: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
    proxyPort: Number(process.env['PROXY_PORT'] ?? 8080),
    proxyBindAddress: process.env['PROXY_BIND_ADDRESS'] ?? '0.0.0.0',
    proxyPublicHost: process.env['PROXY_PUBLIC_HOST'] ?? '',
    clashApiBasePort: Number(process.env['CLASH_API_BASE_PORT'] ?? 9090),
    clashApiSecret:
      process.env['CLASH_API_SECRET'] ?? crypto.randomUUID().replace(/-/g, ''),
    singboxInstancePortStride: Number(process.env['SINGBOX_INSTANCE_PORT_STRIDE'] ?? 1000),
    singboxProxyInboundOffset: Number(process.env['SINGBOX_PROXY_INBOUND_OFFSET'] ?? 0),
    maxDrainSeconds: Number(process.env['MAX_DRAIN_SECONDS'] ?? 300),
    instanceReadyTimeoutMs: Number(process.env['INSTANCE_READY_TIMEOUT_MS'] ?? 8000),
```

`crypto.randomUUID` 是全局可用的 Web Crypto，无需 import。

- [x] **Step 6: 跑测试确认通过**

Run: `bun test src/config.test.ts`
Expected: PASS。

注意：现有 parser/buildConfig/api 测试此刻不需 `originalUri`，因为接口加了必填字段会让别处 `Node` 字面量报类型错。**只在本 task 改 `Node` 接口会破坏现有 parser 返回的对象类型与 monitor.test 的 `makeNode`**。处理方式：本 task 仅追加字段并跑 `src/config.test.ts`；类型完整性在 Task 2 修 parser、并在本 task Step 7 顺手把 `monitor.test.ts` 的 `makeNode` 补 `originalUri: ''` 以保持 `bun test` 全绿。

- [x] **Step 7: 修 monitor.test 的 makeNode**

`src/monitor.test.ts` 的 `makeNode` 改为：

```typescript
function makeNode(key: string): Node {
  return { key, name: `Node-${key}`, protocol: 'trojan', server: 'h.com', port: 443, raw: {}, originalUri: '' };
}
```

- [x] **Step 8: 跑全量测试**

Run: `bun test`
Expected: 仅四个 parser 测试可能因返回对象缺 `originalUri` 报类型错（下一 task 修）；其余 PASS。若 parser 测试因运行时无类型检查仍 PASS，也可接受。记录现状即可。

- [x] **Step 9: Commit**

```bash
git add src/types.ts src/config.ts src/config.test.ts src/monitor.test.ts
git commit -m "feat: add proxy/clash config keys and originalUri/raw type fields"
```

**Done check:** `bun test src/config.test.ts` 全绿；`Config`/`Node`/`NodeView` 含全部新字段。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Task 2: Req1 — parser 保存 originalUri + API 补全 raw/originalUri

实现 tasks.md §2.1 + §2.2。Design Doc §2。

**Files:**
- Modify: `src/subscription/parsers/{trojan,vmess,ss,vless}.ts`
- Modify: `src/api.ts`
- Test: `src/subscription/parsers/{trojan,vmess,ss,vless}.test.ts`（各加一条）
- Test: `src/api.test.ts`（新建）

**Interfaces:**
- Consumes: `Node.originalUri`、`NodeView.raw`/`originalUri`（Task 1）；`Monitor.getNodes(): Node[]`（已存在）；`StateStore`（已存在）。
- Produces: `/nodes`、`/nodes/best` 返回的每个节点对象含 `raw` 与 `originalUri`。

- [x] **Step 1: 写失败测试 — 四 parser 保存 originalUri**

在 `src/subscription/parsers/trojan.test.ts` 的 `describe` 内加：

```typescript
  it('stores the original URI', () => {
    const uri = 'trojan://pass@example.com:443#MyNode';
    const node = parseTrojan(uri);
    expect(node!.originalUri).toBe(uri);
  });
```

在 `vmess.test.ts` 内加（用该文件已有的合法 vmess 样本变量；若无，构造一个）：

```typescript
  it('stores the original URI', () => {
    const json = JSON.stringify({ add: '1.2.3.4', port: '8080', id: 'uuid-x', ps: 'V' });
    const uri = 'vmess://' + btoa(json);
    const node = parseVmess(uri);
    expect(node!.originalUri).toBe(uri);
  });
```

在 `ss.test.ts` 内加：

```typescript
  it('stores the original URI', () => {
    const uri = 'ss://' + btoa('aes-256-gcm:pass') + '@1.2.3.4:8388#SS';
    const node = parseSs(uri);
    expect(node!.originalUri).toBe(uri);
  });
```

在 `vless.test.ts` 内加：

```typescript
  it('stores the original URI', () => {
    const uri = 'vless://uuid-x@1.2.3.4:443?security=tls#VL';
    const node = parseVless(uri);
    expect(node!.originalUri).toBe(uri);
  });
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/subscription/parsers/`
Expected: FAIL（`originalUri` 为 undefined）。

- [x] **Step 3: 四 parser 填 originalUri**

每个 parser 在 `return { ... }` 节点对象里加 `originalUri: uri`：
- `trojan.ts`：返回对象加 `originalUri: uri,`
- `vless.ts`：返回对象加 `originalUri: uri,`
- `vmess.ts`：返回对象加 `originalUri: uri,`
- `ss.ts`：**两个 return 分支**（SIP002 与 legacy）都加 `originalUri: uri,`

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/subscription/parsers/`
Expected: PASS。

- [x] **Step 5: 写失败测试 — API 补全 raw/originalUri**

新建 `src/api.test.ts`：

```typescript
import { describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { registerRoutes } from './api.ts';
import type { Monitor } from './monitor.ts';
import type { StateStore } from './store/state-store.ts';
import type { Node, NodeState } from './types.ts';

function makeNode(key: string): Node {
  return {
    key, name: `N-${key}`, protocol: 'trojan', server: 'h.com', port: 443,
    raw: { password: `pw-${key}`, sni: 'sni.com' },
    originalUri: `trojan://pw-${key}@h.com:443#N-${key}`,
  };
}

function makeState(over: Partial<NodeState> = {}): NodeState {
  return {
    latency: 50, failCount: 0, successCount: 1, lastCheck: Date.now(),
    name: 'N', protocol: 'trojan', server: 'h.com', port: 443, ...over,
  };
}

function fakeStore(states: Record<string, NodeState>, dead: Set<string> = new Set()): StateStore {
  return {
    async getState(k) { return states[k] ?? null; },
    async setState() {},
    async renewTtl() {},
    async isDead(k) { return dead.has(k); },
    async markDead() {},
    async clearDead() {},
  };
}

function fakeMonitor(nodes: Node[]): Monitor {
  return { getNodes: () => nodes } as unknown as Monitor;
}

async function getJson(app: Elysia, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return res.json();
}

describe('GET /nodes raw+originalUri', () => {
  it('returns raw and originalUri for available nodes', async () => {
    const node = makeNode('aaa');
    const app = registerRoutes(new Elysia(), fakeMonitor([node]), fakeStore({ aaa: makeState() }));
    const body = await getJson(app, '/nodes');
    expect(body.nodes.length).toBe(1);
    expect(body.nodes[0].raw.password).toBe('pw-aaa');
    expect(body.nodes[0].originalUri).toBe('trojan://pw-aaa@h.com:443#N-aaa');
  });
});

describe('GET /nodes/best raw+originalUri', () => {
  it('best node carries raw and originalUri', async () => {
    const node = makeNode('bbb');
    const app = registerRoutes(new Elysia(), fakeMonitor([node]), fakeStore({ bbb: makeState() }));
    const body = await getJson(app, '/nodes/best');
    expect(body.best.raw.password).toBe('pw-bbb');
    expect(body.best.originalUri).toBe('trojan://pw-bbb@h.com:443#N-bbb');
  });
});
```

- [x] **Step 6: 跑测试确认失败**

Run: `bun test src/api.test.ts`
Expected: FAIL（`raw`/`originalUri` 为 undefined）。

- [x] **Step 7: 实现 API 补全**

`src/api.ts` 中 `/nodes` 的 `.map(...)` 返回的 NodeView 对象加：

```typescript
        score: score(state!, now),
        raw: node.raw,
        originalUri: node.originalUri,
```

`/nodes/best` 构造 `best` 的对象（`score: s,` 之后）加：

```typescript
          score: s,
          raw: node.raw,
          originalUri: node.originalUri,
```

- [x] **Step 8: 跑测试确认通过**

Run: `bun test src/api.test.ts && bun test`
Expected: 全 PASS。

- [x] **Step 9: Commit**

```bash
git add src/subscription/parsers src/api.ts src/api.test.ts
git commit -m "feat: expose raw and originalUri via /nodes and /nodes/best"
```

**Done check:** `/nodes` 与 `/nodes/best` 返回对象含 `raw` + `originalUri`；四 parser 保存原始 URI。满足 node-health-monitor spec「查询接口返回完整节点信息」。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Task 3: Req2 — 端口可用性探测与排除集分配

实现 tasks.md §3.1 + §3.2。Design Doc §3。`buildConfig` 改用 `allocatePorts` 在 Task 4 与 selector 一起做，这里只做 `ports.ts` 自包含模块。

**Files:**
- Create: `src/singbox/ports.ts`
- Test: `src/singbox/ports.test.ts`

**Interfaces:**
- Produces:
  - `isPortFree(port: number, host?: string): Promise<boolean>`
  - `allocatePorts(count: number, startPort: number, exclude?: Set<number>): Promise<number[]>` — 从 `startPort` 起，跳过 `exclude` 与被占用端口，返回 `count` 个空闲端口（升序）。

- [x] **Step 1: 写失败测试**

新建 `src/singbox/ports.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { isPortFree, allocatePorts } from './ports.ts';

describe('isPortFree', () => {
  const servers: Array<{ stop: () => void }> = [];
  afterEach(() => { servers.forEach((s) => s.stop()); servers.length = 0; });

  it('returns true for a free port', async () => {
    // pick a high port unlikely to be used
    expect(await isPortFree(54011)).toBe(true);
  });

  it('returns false for an occupied port', async () => {
    const srv = Bun.listen({ hostname: '127.0.0.1', port: 54012, socket: { data() {} } });
    servers.push(srv);
    expect(await isPortFree(54012)).toBe(false);
  });
});

describe('allocatePorts', () => {
  const servers: Array<{ stop: () => void }> = [];
  afterEach(() => { servers.forEach((s) => s.stop()); servers.length = 0; });

  it('allocates count free ports from startPort', async () => {
    const ports = await allocatePorts(3, 54020);
    expect(ports.length).toBe(3);
    expect(new Set(ports).size).toBe(3);
    for (const p of ports) expect(p).toBeGreaterThanOrEqual(54020);
  });

  it('skips occupied ports', async () => {
    const srv = Bun.listen({ hostname: '127.0.0.1', port: 54030, socket: { data() {} } });
    servers.push(srv);
    const ports = await allocatePorts(2, 54030);
    expect(ports).not.toContain(54030);
    expect(ports.length).toBe(2);
  });

  it('skips ports in the exclude set', async () => {
    const ports = await allocatePorts(2, 54040, new Set([54040, 54041]));
    expect(ports).not.toContain(54040);
    expect(ports).not.toContain(54041);
    expect(ports.length).toBe(2);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/singbox/ports.test.ts`
Expected: FAIL（模块不存在）。

- [x] **Step 3: 实现 ports.ts**

```typescript
/**
 * Port availability probing and exclusion-aware allocation for sing-box.
 */

/** True if a TCP listen on host:port succeeds (port is free). */
export async function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: host, port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect `count` free ports starting at `startPort`, skipping any port in
 * `exclude` or already in use. Scans a bounded range to avoid infinite loops.
 */
export async function allocatePorts(
  count: number,
  startPort: number,
  exclude: Set<number> = new Set(),
): Promise<number[]> {
  const result: number[] = [];
  const maxScan = count * 50 + 200; // bounded headroom for occupied/excluded ports
  let port = startPort;
  let scanned = 0;
  while (result.length < count && scanned < maxScan) {
    if (!exclude.has(port) && (await isPortFree(port))) {
      result.push(port);
    }
    port++;
    scanned++;
  }
  if (result.length < count) {
    throw new Error(
      `allocatePorts: only found ${result.length}/${count} free ports from ${startPort}`,
    );
  }
  return result;
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/singbox/ports.test.ts`
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add src/singbox/ports.ts src/singbox/ports.test.ts
git commit -m "feat: add port availability probing and exclusion-aware allocation"
```

**Done check:** `allocatePorts` 跳过占用端口与排除集；满足 node-health-monitor spec「sing-box 本地端口分配跳过占用」的分配侧。TOCTOU 启动重试在 Task 7。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Task 4: Req3 — buildConfig 加 in-proxy/selector/block/clash_api + 端口分配

实现 tasks.md §3.2（buildConfig 端口侧）+ §4.1。Design Doc §3、§4「sing-box 配置」。

**Files:**
- Modify: `src/singbox/config.ts`
- Test: `src/singbox/config.test.ts`（新建；若已存在则扩展）

**Interfaces:**
- Consumes: `allocatePorts`（Task 3）、`toOutbound`（已存在）、`Config` 字段（Task 1）。
- Produces: 新签名
  ```typescript
  export interface BuildConfigParams {
    nodes: Node[];
    basePort: number;          // 实例端口段起点
    proxyInboundOffset: number;// in-proxy 相对偏移（config.singboxProxyInboundOffset）
    clashPort: number;         // 该实例 clash 控制口
    clashSecret: string;
    exclude?: Set<number>;     // 蓝绿：旧实例占用端口
  }
  export interface BuildConfigResult {
    config: SingBoxConfig;
    portMap: Map<string, number>; // node.key -> 检查入站端口
    proxyInboundPort: number;     // in-proxy 实际端口（relay 上游）
    clashPort: number;
    usedPorts: number[];          // 本实例占用的全部端口（exclude 用）
  }
  export async function buildConfig(params: BuildConfigParams): Promise<BuildConfigResult>;
  export interface SingBoxConfig {
    log: { level: string };
    inbounds: Record<string, unknown>[];
    outbounds: Record<string, unknown>[];
    route: { rules: Record<string, unknown>[] };
    experimental: { clash_api: { external_controller: string; secret: string } };
  }
  ```
  注意：签名由同步改为 `async`（因 `allocatePorts`）。`SingBoxProcess.start` 在 Task 7 一并改为 await，本 task 先让 config 测试绿，process.ts 暂时编译不过由 Task 7 修。

- [x] **Step 1: 写失败测试**

新建 `src/singbox/config.test.ts`：

```typescript
import { describe, it, expect } from 'bun:test';
import { buildConfig } from './config.ts';
import type { Node } from '../types.ts';

function node(key: string): Node {
  return {
    key, name: `N-${key}`, protocol: 'trojan', server: 'h.com', port: 443,
    raw: { password: 'p', sni: 'h.com' }, originalUri: `trojan://p@h.com:443#${key}`,
  };
}

describe('buildConfig', () => {
  it('allocates a check inbound per node and records portMap', async () => {
    const nodes = [node('a'), node('b')];
    const r = await buildConfig({
      nodes, basePort: 41000, proxyInboundOffset: 0, clashPort: 41900, clashSecret: 's',
    });
    expect(r.portMap.get('a')).toBeGreaterThanOrEqual(41000);
    expect(r.portMap.get('b')).toBeGreaterThanOrEqual(41000);
    expect(r.portMap.get('a')).not.toBe(r.portMap.get('b'));
    expect(r.config.inbounds.some((i) => i['tag'] === 'in-a')).toBe(true);
    expect(r.config.inbounds.some((i) => i['tag'] === 'in-b')).toBe(true);
  });

  it('adds a fixed in-proxy mixed inbound and reports its port', async () => {
    const r = await buildConfig({
      nodes: [node('a')], basePort: 41100, proxyInboundOffset: 0, clashPort: 41950, clashSecret: 's',
    });
    const inProxy = r.config.inbounds.find((i) => i['tag'] === 'in-proxy');
    expect(inProxy).toBeDefined();
    expect(inProxy!['type']).toBe('mixed');
    expect(inProxy!['listen']).toBe('127.0.0.1');
    expect(inProxy!['listen_port']).toBe(r.proxyInboundPort);
  });

  it('adds a selector over all node outbounds with interrupt_exist_connections false', async () => {
    const r = await buildConfig({
      nodes: [node('a'), node('b')], basePort: 41200, proxyInboundOffset: 0, clashPort: 41960, clashSecret: 's',
    });
    const sel = r.config.outbounds.find((o) => o['tag'] === 'proxy-select');
    expect(sel).toBeDefined();
    expect(sel!['type']).toBe('selector');
    expect(sel!['outbounds']).toEqual(['out-a', 'out-b']);
    expect(sel!['interrupt_exist_connections']).toBe(false);
  });

  it('adds a block outbound and routes in-proxy to the selector', async () => {
    const r = await buildConfig({
      nodes: [node('a')], basePort: 41300, proxyInboundOffset: 0, clashPort: 41970, clashSecret: 's',
    });
    expect(r.config.outbounds.some((o) => o['type'] === 'block' && o['tag'] === 'block')).toBe(true);
    expect(r.config.route.rules.some(
      (rule) => Array.isArray(rule['inbound']) && (rule['inbound'] as string[]).includes('in-proxy') && rule['outbound'] === 'proxy-select',
    )).toBe(true);
    expect(r.config.route.rules.some(
      (rule) => Array.isArray(rule['inbound']) && (rule['inbound'] as string[]).includes('in-a') && rule['outbound'] === 'out-a',
    )).toBe(true);
  });

  it('enables clash_api with controller and secret', async () => {
    const r = await buildConfig({
      nodes: [node('a')], basePort: 41400, proxyInboundOffset: 0, clashPort: 41980, clashSecret: 'topsecret',
    });
    expect(r.config.experimental.clash_api.external_controller).toBe('127.0.0.1:41980');
    expect(r.config.experimental.clash_api.secret).toBe('topsecret');
    expect(r.clashPort).toBe(41980);
  });

  it('excludes ports in the exclude set from allocation', async () => {
    const exclude = new Set([41500, 41501]);
    const r = await buildConfig({
      nodes: [node('a')], basePort: 41500, proxyInboundOffset: 0, clashPort: 41990, clashSecret: 's', exclude,
    });
    for (const p of r.usedPorts) {
      expect(exclude.has(p)).toBe(false);
    }
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/singbox/config.test.ts`
Expected: FAIL（旧 `buildConfig` 签名为 `(nodes, basePort)` 同步、无 selector/clash_api）。

- [x] **Step 3: 实现 buildConfig**

重写 `src/singbox/config.ts`：

```typescript
import type { Node } from '../types.ts';
import { toOutbound } from './outbound.ts';
import { allocatePorts } from './ports.ts';

export interface SingBoxConfig {
  log: { level: string };
  inbounds: Record<string, unknown>[];
  outbounds: Record<string, unknown>[];
  route: { rules: Record<string, unknown>[] };
  experimental: { clash_api: { external_controller: string; secret: string } };
}

export interface BuildConfigParams {
  nodes: Node[];
  basePort: number;
  proxyInboundOffset: number;
  clashPort: number;
  clashSecret: string;
  exclude?: Set<number>;
}

export interface BuildConfigResult {
  config: SingBoxConfig;
  portMap: Map<string, number>;
  proxyInboundPort: number;
  clashPort: number;
  usedPorts: number[];
}

/**
 * Build sing-box config for one instance:
 * - per-node check inbound (mixed) + outbound, routed in-<key> -> out-<key>
 * - fixed in-proxy mixed inbound -> selector (proxy-select) over all node outbounds
 * - block outbound; clash_api enabled for runtime selector control
 * Ports are allocated by availability, skipping `exclude` and occupied ports.
 */
export async function buildConfig(params: BuildConfigParams): Promise<BuildConfigResult> {
  const { nodes, basePort, proxyInboundOffset, clashPort, clashSecret, exclude } = params;
  const excludeSet = new Set(exclude ?? []);

  // 1 port per node check inbound + 1 in-proxy port
  const needed = nodes.length + 1;
  const ports = await allocatePorts(needed, basePort, excludeSet);

  const portMap = new Map<string, number>();
  const inbounds: Record<string, unknown>[] = [];
  const outbounds: Record<string, unknown>[] = [];
  const rules: Record<string, unknown>[] = [];
  const usedPorts: number[] = [clashPort];

  nodes.forEach((node, i) => {
    const port = ports[i]!;
    portMap.set(node.key, port);
    usedPorts.push(port);

    inbounds.push({
      type: 'mixed',
      tag: `in-${node.key}`,
      listen: '127.0.0.1',
      listen_port: port,
    });
    outbounds.push(toOutbound(node));
    rules.push({ inbound: [`in-${node.key}`], outbound: `out-${node.key}` });
  });

  // in-proxy: last allocated port + configurable offset
  const proxyInboundPort = ports[nodes.length]! + proxyInboundOffset;
  usedPorts.push(proxyInboundPort);

  inbounds.push({
    type: 'mixed',
    tag: 'in-proxy',
    listen: '127.0.0.1',
    listen_port: proxyInboundPort,
  });

  outbounds.push({
    type: 'selector',
    tag: 'proxy-select',
    outbounds: nodes.map((n) => `out-${n.key}`),
    interrupt_exist_connections: false,
  });
  outbounds.push({ type: 'block', tag: 'block' });

  rules.push({ inbound: ['in-proxy'], outbound: 'proxy-select' });

  const config: SingBoxConfig = {
    log: { level: 'warn' },
    inbounds,
    outbounds,
    route: { rules },
    experimental: {
      clash_api: { external_controller: `127.0.0.1:${clashPort}`, secret: clashSecret },
    },
  };

  return { config, portMap, proxyInboundPort, clashPort, usedPorts };
}
```

注意 `proxyInboundOffset` 通常为 0；非 0 时若与已分配端口冲突由 Task 7 启动重试兜底。

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/singbox/config.test.ts`
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add src/singbox/config.ts src/singbox/config.test.ts
git commit -m "feat: buildConfig adds in-proxy/selector/block/clash_api with port allocation"
```

**Done check:** buildConfig 产出含 in-proxy、`proxy-select`（`interrupt_exist_connections:false`）、block、clash_api，端口按可用分配并避开 exclude。满足 best-proxy-gateway spec「基于评分的 best 节点热切换」配置侧与「切换不中断已建立连接」selector 侧。`process.ts` 此刻编译不过属预期，Task 7 修。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Task 5: Req3 — Clash API 客户端

实现 tasks.md §4.2。Design Doc §4「ClashClient」。

**Files:**
- Create: `src/singbox/clash.ts`
- Test: `src/singbox/clash.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export class ClashClient {
    constructor(baseUrl: string, secret: string); // baseUrl 如 'http://127.0.0.1:9090'
    setSelector(outboundTag: string): Promise<void>; // PUT /proxies/proxy-select {name}
    waitReady(timeoutMs: number): Promise<boolean>;   // 轮询 GET / 直到 2xx
  }
  export function clashBaseUrl(port: number): string; // `http://127.0.0.1:${port}`
  ```
  selector 名固定 `proxy-select`（与 buildConfig 一致）。

- [x] **Step 1: 写失败测试（用真实 Bun.serve mock HTTP）**

新建 `src/singbox/clash.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { ClashClient, clashBaseUrl } from './clash.ts';

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; });

describe('ClashClient.setSelector', () => {
  it('PUTs the selector name with bearer auth', async () => {
    const seen: { method?: string; path?: string; auth?: string; body?: any } = {};
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.method = req.method;
        seen.path = url.pathname;
        seen.auth = req.headers.get('authorization') ?? undefined;
        seen.body = await req.json();
        return new Response('', { status: 204 });
      },
    });
    const client = new ClashClient(`http://127.0.0.1:${server.port}`, 'sekret');
    await client.setSelector('out-abc');
    expect(seen.method).toBe('PUT');
    expect(seen.path).toBe('/proxies/proxy-select');
    expect(seen.auth).toBe('Bearer sekret');
    expect(seen.body).toEqual({ name: 'out-abc' });
  });

  it('throws on non-2xx response', async () => {
    server = Bun.serve({ port: 0, fetch() { return new Response('nope', { status: 500 }); } });
    const client = new ClashClient(`http://127.0.0.1:${server.port}`, 's');
    await expect(client.setSelector('out-x')).rejects.toThrow();
  });
});

describe('ClashClient.waitReady', () => {
  it('returns true once GET / responds 2xx', async () => {
    server = Bun.serve({ port: 0, fetch() { return new Response('{}', { status: 200 }); } });
    const client = new ClashClient(`http://127.0.0.1:${server.port}`, 's');
    expect(await client.waitReady(2000)).toBe(true);
  });

  it('returns false when never ready before timeout', async () => {
    // point at a port with nothing listening
    const client = new ClashClient('http://127.0.0.1:6', 's');
    expect(await client.waitReady(300)).toBe(false);
  });
});

describe('clashBaseUrl', () => {
  it('builds a loopback url', () => {
    expect(clashBaseUrl(9090)).toBe('http://127.0.0.1:9090');
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/singbox/clash.test.ts`
Expected: FAIL（模块不存在）。

- [x] **Step 3: 实现 clash.ts**

```typescript
/**
 * Minimal Clash API client for sing-box runtime selector control.
 */
export function clashBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export class ClashClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.secret) h['Authorization'] = `Bearer ${this.secret}`;
    return h;
  }

  /** Switch the `proxy-select` selector to the given outbound tag. */
  async setSelector(outboundTag: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/proxies/proxy-select`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ name: outboundTag }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`setSelector(${outboundTag}) failed: HTTP ${res.status}`);
    }
  }

  /** Poll GET / until a 2xx response or timeout. */
  async waitReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(Math.min(1000, timeoutMs)),
        });
        if (res.status >= 200 && res.status < 300) return true;
      } catch {
        // not ready yet
      }
      await Bun.sleep(100);
    }
    return false;
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/singbox/clash.test.ts`
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add src/singbox/clash.ts src/singbox/clash.test.ts
git commit -m "feat: add Clash API client for selector hot-switch and readiness"
```

**Done check:** `setSelector` 发 `PUT /proxies/proxy-select` 带 bearer；`waitReady` 轮询就绪。满足 best-proxy-gateway spec「基于评分的 best 节点热切换」客户端侧。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Task 6: Req3-HA — 常驻 TCP relay

实现 tasks.md §5.1。Design Doc §5「TcpRelay」。

**Files:**
- Create: `src/relay.ts`
- Test: `src/relay.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface RelayOptions {
    bindAddress: string;
    port: number;
    initialUpstreamPort: number;
    upstreamHost?: string; // default '127.0.0.1'
  }
  export class TcpRelay {
    constructor(opts: RelayOptions);
    start(): void;                       // Bun.listen 常驻
    stop(): void;
    setUpstream(port: number): void;     // 原子切换;不影响已建立连接
    get activeUpstreamPort(): number;
    get activeConnectionCount(): number; // 当前在途连接数(供蓝绿排空判断)
    countConnectionsTo(port: number): number; // 仍连到某 upstream 的连接数
  }
  ```
- 每条入站连接在建立时快照当前 `activeUpstreamPort` 并固定到该 upstream，`setUpstream` 后仍走旧 upstream（保留）。

- [x] **Step 1: 写失败测试（本地 echo TCP 上游 A/B）**

新建 `src/relay.test.ts`：

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { TcpRelay } from './relay.ts';

// echo server that prefixes each reply with a label, so we can tell A from B
function startEcho(label: string) {
  return Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, data) { socket.write(`${label}:` + data.toString()); },
      open() {},
    },
  });
}

async function sendAndRead(port: number, msg: string, waitMs = 150): Promise<string> {
  let buf = '';
  const conn = await Bun.connect({
    hostname: '127.0.0.1', port,
    socket: { data(_s, d) { buf += d.toString(); }, open(s) { s.write(msg); } },
  });
  await Bun.sleep(waitMs);
  conn.end();
  return buf;
}

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups.length = 0; });

describe('TcpRelay', () => {
  it('transparently forwards to the active upstream', async () => {
    const a = startEcho('A');
    cleanups.push(() => a.stop(true));
    const relay = new TcpRelay({ bindAddress: '127.0.0.1', port: 0, initialUpstreamPort: a.port });
    relay.start();
    cleanups.push(() => relay.stop());
    const reply = await sendAndRead(relay.port, 'hello');
    expect(reply).toBe('A:hello');
  });

  it('new connections use the new upstream after setUpstream', async () => {
    const a = startEcho('A');
    const b = startEcho('B');
    cleanups.push(() => a.stop(true), () => b.stop(true));
    const relay = new TcpRelay({ bindAddress: '127.0.0.1', port: 0, initialUpstreamPort: a.port });
    relay.start();
    cleanups.push(() => relay.stop());
    expect(await sendAndRead(relay.port, 'x')).toBe('A:x');
    relay.setUpstream(b.port);
    expect(await sendAndRead(relay.port, 'y')).toBe('B:y');
  });

  it('keeps an established connection pinned to its original upstream', async () => {
    const a = startEcho('A');
    const b = startEcho('B');
    cleanups.push(() => a.stop(true), () => b.stop(true));
    const relay = new TcpRelay({ bindAddress: '127.0.0.1', port: 0, initialUpstreamPort: a.port });
    relay.start();
    cleanups.push(() => relay.stop());

    let buf = '';
    const conn = await Bun.connect({
      hostname: '127.0.0.1', port: relay.port,
      socket: { data(_s, d) { buf += d.toString(); }, open(s) { s.write('first'); } },
    });
    await Bun.sleep(120);
    expect(buf).toBe('A:first');

    relay.setUpstream(b.port); // switch upstream while conn is open
    buf = '';
    conn.write('second');
    await Bun.sleep(120);
    expect(buf).toBe('A:second'); // still A, not B
    conn.end();
  });

  it('reports active connection counts per upstream', async () => {
    const a = startEcho('A');
    cleanups.push(() => a.stop(true));
    const relay = new TcpRelay({ bindAddress: '127.0.0.1', port: 0, initialUpstreamPort: a.port });
    relay.start();
    cleanups.push(() => relay.stop());
    const conn = await Bun.connect({
      hostname: '127.0.0.1', port: relay.port,
      socket: { data() {}, open(s) { s.write('keepopen'); } },
    });
    await Bun.sleep(80);
    expect(relay.countConnectionsTo(a.port)).toBeGreaterThanOrEqual(1);
    conn.end();
    await Bun.sleep(80);
    expect(relay.countConnectionsTo(a.port)).toBe(0);
  });
});
```

注：`TcpRelay.port` 在 `port:0` 时返回实际监听端口，需暴露 getter。

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/relay.test.ts`
Expected: FAIL（模块不存在）。

- [x] **Step 3: 实现 relay.ts**

```typescript
/**
 * Always-on transparent TCP relay. Listens on a fixed public port and pipes
 * each new connection to a mutable upstream port. Switching the upstream does
 * NOT affect connections already established (they stay pinned to their
 * original upstream), enabling graceful blue-green drain.
 */
type TcpSocket = import('bun').Socket;

interface ConnPair {
  upstreamPort: number;
  client: TcpSocket;
  upstream: TcpSocket | null;
  clientBuffer: Uint8Array[]; // bytes received before upstream connected
  upstreamReady: boolean;
}

export interface RelayOptions {
  bindAddress: string;
  port: number;
  initialUpstreamPort: number;
  upstreamHost?: string;
}

export class TcpRelay {
  private server: ReturnType<typeof Bun.listen> | null = null;
  private upstreamPort: number;
  private readonly upstreamHost: string;
  private readonly conns = new Set<ConnPair>();

  constructor(private readonly opts: RelayOptions) {
    this.upstreamPort = opts.initialUpstreamPort;
    this.upstreamHost = opts.upstreamHost ?? '127.0.0.1';
  }

  get port(): number {
    return this.server?.port ?? this.opts.port;
  }

  get activeUpstreamPort(): number {
    return this.upstreamPort;
  }

  get activeConnectionCount(): number {
    return this.conns.size;
  }

  countConnectionsTo(port: number): number {
    let n = 0;
    for (const c of this.conns) if (c.upstreamPort === port) n++;
    return n;
  }

  setUpstream(port: number): void {
    this.upstreamPort = port;
  }

  start(): void {
    const self = this;
    this.server = Bun.listen({
      hostname: this.opts.bindAddress,
      port: this.opts.port,
      socket: {
        open(client) {
          const pair: ConnPair = {
            upstreamPort: self.upstreamPort, // snapshot at accept time
            client,
            upstream: null,
            clientBuffer: [],
            upstreamReady: false,
          };
          (client as unknown as { data: ConnPair }).data = pair;
          self.conns.add(pair);
          void self.connectUpstream(pair);
        },
        data(client, chunk) {
          const pair = (client as unknown as { data: ConnPair }).data;
          if (pair.upstream && pair.upstreamReady) {
            pair.upstream.write(chunk);
          } else {
            pair.clientBuffer.push(new Uint8Array(chunk));
          }
        },
        close(client) {
          const pair = (client as unknown as { data: ConnPair }).data;
          if (pair) self.teardown(pair, 'client');
        },
        error(client) {
          const pair = (client as unknown as { data: ConnPair }).data;
          if (pair) self.teardown(pair, 'client');
        },
      },
    });
  }

  private async connectUpstream(pair: ConnPair): Promise<void> {
    const self = this;
    try {
      pair.upstream = await Bun.connect({
        hostname: this.upstreamHost,
        port: pair.upstreamPort,
        socket: {
          open(up) {
            pair.upstreamReady = true;
            for (const buffered of pair.clientBuffer) up.write(buffered);
            pair.clientBuffer = [];
          },
          data(_up, chunk) {
            pair.client.write(chunk);
          },
          close() {
            self.teardown(pair, 'upstream');
          },
          error() {
            self.teardown(pair, 'upstream');
          },
        },
      });
    } catch {
      this.teardown(pair, 'upstream');
    }
  }

  private teardown(pair: ConnPair, _origin: 'client' | 'upstream'): void {
    if (!this.conns.has(pair)) return;
    this.conns.delete(pair);
    try { pair.client.end(); } catch {}
    try { pair.upstream?.end(); } catch {}
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    for (const pair of [...this.conns]) this.teardown(pair, 'client');
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/relay.test.ts`
Expected: PASS。若 echo 时序偶发抖动，提高 `sendAndRead` 的 `waitMs`，不要改断言语义。

- [x] **Step 5: Commit**

```bash
git add src/relay.ts src/relay.test.ts
git commit -m "feat: add always-on transparent TCP relay with atomic upstream switch"
```

**Done check:** relay 透明转发、`setUpstream` 后新连接走新上游、已建立连接保留旧上游、可统计在途连接。满足 best-proxy-gateway spec「固定转发代理入口」与「切换不中断已建立连接」蓝绿排空侧的 relay 基础。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Task 7: SingBoxInstance 封装 + 就绪探测 + TOCTOU 启动重试

实现 tasks.md §3.3 + §5.2。Design Doc §3（TOCTOU 兜底）、§5「就绪探测」。重构 `process.ts`：把单进程封装为可多实例并存的 `SingBoxInstance`（持有自己的端口段、clash 口、in-proxy 口、portMap），并提供 `ready()`。

**Files:**
- Create: `src/singbox/instance.ts`
- Modify: `src/singbox/process.ts`（保留向后兼容或标记弃用；index 在 Task 11 切换到 orchestrator）
- Test: `src/singbox/instance.test.ts`

**Interfaces:**
- Consumes: `buildConfig`（Task 4）、`ClashClient`（Task 5）、`isPortFree`（Task 3）。
- Produces:
  ```typescript
  export interface InstanceParams {
    binPath: string;
    nodes: Node[];
    basePort: number;
    proxyInboundOffset: number;
    clashPort: number;
    clashSecret: string;
    readyTimeoutMs: number;
    exclude?: Set<number>;
    spawn?: SpawnFn;      // injectable for tests; default Bun.spawn wrapper
    maxStartRetries?: number; // default 1 (one higher-range retry)
    portStride?: number;  // higher-range step on retry; default 1000
  }
  export interface SpawnHandle { exitCode: number | null; kill(): void; exited: Promise<number>; }
  export type SpawnFn = (cmd: string[]) => SpawnHandle;
  export class SingBoxInstance {
    constructor(params: InstanceParams);
    start(): Promise<void>;            // build config + spawn; on port-race exit, retry higher range
    ready(): Promise<boolean>;         // clash.waitReady && TCP connect to in-proxy port
    stop(): Promise<void>;
    readonly clash: ClashClient;
    get portMap(): Map<string, number>;
    get proxyInboundPort(): number;
    get clashPort(): number;
    get usedPorts(): number[];
  }
  ```
- 注：`start()` 失败重试时把 `basePort`、`clashPort` 各加 `portStride`，重建配置；仅重试 `maxStartRetries` 次。

- [x] **Step 1: 写失败测试（注入 fake spawn，不起真 sing-box）**

新建 `src/singbox/instance.test.ts`：

```typescript
import { describe, it, expect } from 'bun:test';
import { SingBoxInstance, type SpawnHandle } from './instance.ts';
import type { Node } from '../types.ts';

function node(key: string): Node {
  return { key, name: key, protocol: 'trojan', server: 'h.com', port: 443, raw: { password: 'p' }, originalUri: `trojan://p@h.com:443#${key}` };
}

// fake spawn that stays "running" (exitCode null)
function runningSpawn(): { fn: (cmd: string[]) => SpawnHandle; killed: () => boolean } {
  let killed = false;
  return {
    killed: () => killed,
    fn: () => ({ exitCode: null, kill() { killed = true; }, exited: Promise.resolve(0) }),
  };
}

describe('SingBoxInstance.start', () => {
  it('builds config and records ports without throwing when process stays up', async () => {
    const s = runningSpawn();
    const inst = new SingBoxInstance({
      binPath: 'fake', nodes: [node('a'), node('b')], basePort: 42000,
      proxyInboundOffset: 0, clashPort: 42900, clashSecret: 's',
      readyTimeoutMs: 500, spawn: s.fn,
    });
    await inst.start();
    expect(inst.portMap.get('a')).toBeGreaterThanOrEqual(42000);
    expect(inst.proxyInboundPort).toBeGreaterThanOrEqual(42000);
    expect(inst.clashPort).toBe(42900);
    await inst.stop();
    expect(s.killed()).toBe(true);
  });

  it('retries on a higher port range when the first spawn exits immediately', async () => {
    let calls = 0;
    const spawn = (_cmd: string[]): SpawnHandle => {
      calls++;
      const dies = calls === 1; // first attempt "loses port race"
      return { exitCode: dies ? 1 : null, kill() {}, exited: Promise.resolve(dies ? 1 : 0) };
    };
    const inst = new SingBoxInstance({
      binPath: 'fake', nodes: [node('a')], basePort: 43000,
      proxyInboundOffset: 0, clashPort: 43900, clashSecret: 's',
      readyTimeoutMs: 300, spawn, maxStartRetries: 1, portStride: 1000,
    });
    await inst.start();
    expect(calls).toBe(2);
    expect(inst.clashPort).toBe(44900); // bumped by stride on retry
  });

  it('throws after exhausting retries', async () => {
    const spawn = (_cmd: string[]): SpawnHandle => ({ exitCode: 1, kill() {}, exited: Promise.resolve(1) });
    const inst = new SingBoxInstance({
      binPath: 'fake', nodes: [node('a')], basePort: 45000,
      proxyInboundOffset: 0, clashPort: 45900, clashSecret: 's',
      readyTimeoutMs: 100, spawn, maxStartRetries: 1,
    });
    await expect(inst.start()).rejects.toThrow();
  });
});

describe('SingBoxInstance.ready', () => {
  it('returns false when clash never becomes ready', async () => {
    const spawn = (_cmd: string[]): SpawnHandle => ({ exitCode: null, kill() {}, exited: Promise.resolve(0) });
    const inst = new SingBoxInstance({
      binPath: 'fake', nodes: [node('a')], basePort: 46000,
      proxyInboundOffset: 0, clashPort: 46900, clashSecret: 's',
      readyTimeoutMs: 300, spawn,
    });
    await inst.start();
    // nothing is listening on clash/in-proxy ports -> not ready
    expect(await inst.ready()).toBe(false);
    await inst.stop();
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/singbox/instance.test.ts`
Expected: FAIL（模块不存在）。

- [x] **Step 3: 实现 instance.ts**

```typescript
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '../types.ts';
import { buildConfig } from './config.ts';
import { ClashClient, clashBaseUrl } from './clash.ts';

export interface SpawnHandle {
  exitCode: number | null;
  kill(): void;
  exited: Promise<number>;
}
export type SpawnFn = (cmd: string[]) => SpawnHandle;

export interface InstanceParams {
  binPath: string;
  nodes: Node[];
  basePort: number;
  proxyInboundOffset: number;
  clashPort: number;
  clashSecret: string;
  readyTimeoutMs: number;
  exclude?: Set<number>;
  spawn?: SpawnFn;
  maxStartRetries?: number;
  portStride?: number;
}

function defaultSpawn(cmd: string[]): SpawnHandle {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return {
    get exitCode() { return proc.exitCode; },
    kill() { proc.kill(); },
    exited: proc.exited,
  };
}

async function tcpReachable(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const conn = await Bun.connect({
      hostname: '127.0.0.1', port,
      socket: { data() {}, open() {} },
    });
    conn.end();
    return true;
  } catch {
    return false;
  }
}

export class SingBoxInstance {
  private proc: SpawnHandle | null = null;
  private readonly configPath: string;
  private _portMap = new Map<string, number>();
  private _proxyInboundPort = 0;
  private _clashPort: number;
  private _usedPorts: number[] = [];
  public clash: ClashClient;

  constructor(private readonly params: InstanceParams) {
    this._clashPort = params.clashPort;
    this.configPath = join(tmpdir(), `singbox-${params.basePort}-${Date.now()}.json`);
    this.clash = new ClashClient(clashBaseUrl(params.clashPort), params.clashSecret);
  }

  get portMap() { return this._portMap; }
  get proxyInboundPort() { return this._proxyInboundPort; }
  get clashPort() { return this._clashPort; }
  get usedPorts() { return this._usedPorts; }

  async start(): Promise<void> {
    const spawn = this.params.spawn ?? defaultSpawn;
    const stride = this.params.portStride ?? 1000;
    const maxRetries = this.params.maxStartRetries ?? 1;

    let basePort = this.params.basePort;
    let clashPort = this.params.clashPort;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const built = await buildConfig({
        nodes: this.params.nodes,
        basePort,
        proxyInboundOffset: this.params.proxyInboundOffset,
        clashPort,
        clashSecret: this.params.clashSecret,
        exclude: this.params.exclude,
      });
      await writeFile(this.configPath, JSON.stringify(built.config, null, 2));
      const proc = spawn([this.params.binPath, 'run', '-c', this.configPath]);

      await Bun.sleep(1500); // let sing-box bind ports
      if (proc.exitCode === null) {
        // running
        this.proc = proc;
        this._portMap = built.portMap;
        this._proxyInboundPort = built.proxyInboundPort;
        this._clashPort = clashPort;
        this._usedPorts = built.usedPorts;
        this.clash = new ClashClient(clashBaseUrl(clashPort), this.params.clashSecret);
        return;
      }
      lastErr = new Error(`sing-box exited (code ${proc.exitCode}) on attempt ${attempt + 1}`);
      basePort += stride;
      clashPort += stride;
    }
    throw lastErr ?? new Error('sing-box failed to start');
  }

  async ready(): Promise<boolean> {
    const clashOk = await this.clash.waitReady(this.params.readyTimeoutMs);
    if (!clashOk) return false;
    return tcpReachable(this._proxyInboundPort, this.params.readyTimeoutMs);
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      await this.proc.exited;
      this.proc = null;
    }
  }
}
```

`tcpReachable` 的 `timeoutMs` 参数保留以便后续加 AbortSignal；当前用 connect 成功/失败即可。

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/singbox/instance.test.ts`
Expected: PASS。

- [x] **Step 5: 修复 process.ts 编译**

`src/index.ts` 仍 import 旧 `SingBoxProcess`，但 `SingBoxProcess.start` 调用了已改签名的 `buildConfig`（Task 4 起编译不过）。本 task 把 `src/singbox/process.ts` 内的 `start` 改为调用新 `buildConfig`（包一层），或直接让 `process.ts` 委托给 `SingBoxInstance`。最简做法：将 `process.ts` 标记为不再使用并从 `index.ts` 的 import 移除留到 Task 11。这里先让 `process.ts` 编译通过 —— 把其 `start` 改为：

```typescript
  async start(nodes: Node[]): Promise<Map<string, number>> {
    const { buildConfig } = await import('./config.ts');
    const { config, portMap } = await buildConfig({
      nodes,
      basePort: this.basePort,
      proxyInboundOffset: 0,
      clashPort: this.basePort + 9000,
      clashSecret: 'legacy',
    });
    await writeFile(this.configPath, JSON.stringify(config, null, 2));
    // ...rest unchanged (spawn, sleep, exitCode check, return portMap)
  }
```

（保留其余 spawn/stderr/sleep 逻辑不变。此为过渡桩，Task 11 用 orchestrator 取代后可删。）

- [x] **Step 6: 跑全量测试确认无回归**

Run: `bun test`
Expected: 全 PASS。

- [x] **Step 7: Commit**

```bash
git add src/singbox/instance.ts src/singbox/instance.test.ts src/singbox/process.ts
git commit -m "feat: add SingBoxInstance with readiness probe and TOCTOU start retry"
```

**Done check:** 实例可起停、就绪探测 = clash ready + in-proxy 可连、端口竞争启动失败回退更高端口段。满足 node-health-monitor spec「起始端口段存在占用仍能启动」的启动重试侧与 best-proxy-gateway spec「新实例就绪后才切换上游」就绪侧。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Task 8: Req3-HA — 蓝绿编排器

实现 tasks.md §5.3。Design Doc §5「InstanceOrchestrator」。

**Files:**
- Create: `src/singbox/orchestrator.ts`
- Test: `src/singbox/orchestrator.test.ts`

**Interfaces:**
- Consumes: `SingBoxInstance`（Task 7，按接口 mock）、`TcpRelay`（Task 6，按接口 mock）。
- Produces:
  ```typescript
  export interface InstanceLike {
    start(): Promise<void>;
    ready(): Promise<boolean>;
    stop(): Promise<void>;
    portMap: Map<string, number>;
    proxyInboundPort: number;
    usedPorts: number[];
    clash: { setSelector(tag: string): Promise<void> };
  }
  export interface RelayLike {
    setUpstream(port: number): void;
    countConnectionsTo(port: number): number;
  }
  export interface OrchestratorParams {
    relay: RelayLike;
    initial: InstanceLike;
    createInstance: (nodes: Node[], exclude: Set<number>) => InstanceLike;
    maxDrainSeconds: number;
    onActiveChange?: (inst: InstanceLike) => void; // monitor 更新 portMap/clash 用
    drainPollMs?: number; // default 1000
  }
  export class InstanceOrchestrator {
    constructor(params: OrchestratorParams);
    get active(): InstanceLike;
    blueGreenSwap(newNodes: Node[]): Promise<boolean>; // true=切换成功
  }
  ```
- 流程（Design Doc §5）：建新实例（exclude=旧 usedPorts）→ start → ready；ready 失败则 stop 新实例、保留旧、返回 false。ready 成功 → `onActiveChange(new)` → relay.setUpstream(new.proxyInboundPort) → 后台优雅排空旧实例（轮询 `countConnectionsTo(old.proxyInboundPort)`，到 0 或超 maxDrainSeconds 才 `old.stop()`）。

- [x] **Step 1: 写失败测试（全 mock）**

新建 `src/singbox/orchestrator.test.ts`：

```typescript
import { describe, it, expect } from 'bun:test';
import { InstanceOrchestrator, type InstanceLike, type RelayLike } from './orchestrator.ts';
import type { Node } from '../types.ts';

function node(key: string): Node {
  return { key, name: key, protocol: 'trojan', server: 'h.com', port: 443, raw: {}, originalUri: '' };
}

function fakeInstance(over: Partial<InstanceLike> & { proxyInboundPort: number; ready?: boolean }): InstanceLike {
  const setCalls: string[] = [];
  const inst: any = {
    started: false, stopped: false, selectorCalls: setCalls,
    proxyInboundPort: over.proxyInboundPort,
    portMap: over.portMap ?? new Map(),
    usedPorts: over.usedPorts ?? [over.proxyInboundPort],
    async start() { this.started = true; },
    async ready() { return over.ready ?? true; },
    async stop() { this.stopped = true; },
    clash: { async setSelector(t: string) { setCalls.push(t); } },
  };
  return inst;
}

function fakeRelay(): RelayLike & { upstream: number; counts: Map<number, number> } {
  const counts = new Map<number, number>();
  return {
    upstream: 0,
    counts,
    setUpstream(p) { this.upstream = p; },
    countConnectionsTo(p) { return counts.get(p) ?? 0; },
  };
}

describe('InstanceOrchestrator.blueGreenSwap', () => {
  it('switches relay upstream only after the new instance is ready', async () => {
    const relay = fakeRelay();
    const oldInst = fakeInstance({ proxyInboundPort: 5000 });
    relay.setUpstream(oldInst.proxyInboundPort);
    const newInst = fakeInstance({ proxyInboundPort: 6000 });
    const orch = new InstanceOrchestrator({
      relay, initial: oldInst,
      createInstance: () => newInst,
      maxDrainSeconds: 0, drainPollMs: 5,
    });
    const ok = await orch.blueGreenSwap([node('a')]);
    expect(ok).toBe(true);
    expect((newInst as any).started).toBe(true);
    expect(relay.upstream).toBe(6000);
    expect(orch.active).toBe(newInst);
  });

  it('keeps the old instance and returns false when the new one is not ready', async () => {
    const relay = fakeRelay();
    const oldInst = fakeInstance({ proxyInboundPort: 5000 });
    relay.setUpstream(5000);
    const newInst = fakeInstance({ proxyInboundPort: 6000, ready: false });
    const orch = new InstanceOrchestrator({
      relay, initial: oldInst, createInstance: () => newInst,
      maxDrainSeconds: 0, drainPollMs: 5,
    });
    const ok = await orch.blueGreenSwap([node('a')]);
    expect(ok).toBe(false);
    expect(relay.upstream).toBe(5000);        // unchanged
    expect((newInst as any).stopped).toBe(true); // discarded
    expect(orch.active).toBe(oldInst);
  });

  it('drains old connections then stops the old instance', async () => {
    const relay = fakeRelay();
    const oldInst = fakeInstance({ proxyInboundPort: 5000 });
    relay.setUpstream(5000);
    relay.counts.set(5000, 1); // one lingering connection
    const newInst = fakeInstance({ proxyInboundPort: 6000 });
    const orch = new InstanceOrchestrator({
      relay, initial: oldInst, createInstance: () => newInst,
      maxDrainSeconds: 5, drainPollMs: 10,
    });
    await orch.blueGreenSwap([node('a')]);
    expect((oldInst as any).stopped).toBe(false); // still draining
    relay.counts.set(5000, 0);                    // connection closes
    await Bun.sleep(40);
    expect((oldInst as any).stopped).toBe(true);
  });

  it('hard-stops the old instance after maxDrainSeconds even if connections linger', async () => {
    const relay = fakeRelay();
    const oldInst = fakeInstance({ proxyInboundPort: 5000 });
    relay.setUpstream(5000);
    relay.counts.set(5000, 3); // never drains
    const newInst = fakeInstance({ proxyInboundPort: 6000 });
    const orch = new InstanceOrchestrator({
      relay, initial: oldInst, createInstance: () => newInst,
      maxDrainSeconds: 0.05, drainPollMs: 10, // 50ms cap
    });
    await orch.blueGreenSwap([node('a')]);
    await Bun.sleep(120);
    expect((oldInst as any).stopped).toBe(true);
  });

  it('passes old usedPorts as exclude to createInstance', async () => {
    const relay = fakeRelay();
    const oldInst = fakeInstance({ proxyInboundPort: 5000, usedPorts: [5000, 5001, 5900] });
    relay.setUpstream(5000);
    let seenExclude: Set<number> | null = null;
    const newInst = fakeInstance({ proxyInboundPort: 6000 });
    const orch = new InstanceOrchestrator({
      relay, initial: oldInst,
      createInstance: (_n, exclude) => { seenExclude = exclude; return newInst; },
      maxDrainSeconds: 0, drainPollMs: 5,
    });
    await orch.blueGreenSwap([node('a')]);
    expect([...(seenExclude as unknown as Set<number>)]).toEqual([5000, 5001, 5900]);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/singbox/orchestrator.test.ts`
Expected: FAIL（模块不存在）。

- [x] **Step 3: 实现 orchestrator.ts**

```typescript
import type { Node } from '../types.ts';

export interface InstanceLike {
  start(): Promise<void>;
  ready(): Promise<boolean>;
  stop(): Promise<void>;
  portMap: Map<string, number>;
  proxyInboundPort: number;
  usedPorts: number[];
  clash: { setSelector(tag: string): Promise<void> };
}

export interface RelayLike {
  setUpstream(port: number): void;
  countConnectionsTo(port: number): number;
}

export interface OrchestratorParams {
  relay: RelayLike;
  initial: InstanceLike;
  createInstance: (nodes: Node[], exclude: Set<number>) => InstanceLike;
  maxDrainSeconds: number;
  onActiveChange?: (inst: InstanceLike) => void;
  drainPollMs?: number;
}

export class InstanceOrchestrator {
  private _active: InstanceLike;

  constructor(private readonly params: OrchestratorParams) {
    this._active = params.initial;
  }

  get active(): InstanceLike {
    return this._active;
  }

  /**
   * Blue-green swap to a new instance built from newNodes.
   * Returns true if the upstream was switched; false if the new instance
   * failed readiness (old instance retained).
   */
  async blueGreenSwap(newNodes: Node[]): Promise<boolean> {
    const old = this._active;
    const exclude = new Set(old.usedPorts);
    const next = this.params.createInstance(newNodes, exclude);

    try {
      await next.start();
    } catch {
      try { await next.stop(); } catch {}
      return false;
    }

    const ok = await next.ready();
    if (!ok) {
      try { await next.stop(); } catch {}
      return false;
    }

    this._active = next;
    this.params.onActiveChange?.(next);
    this.params.relay.setUpstream(next.proxyInboundPort);

    // Graceful drain of the old instance in the background.
    void this.drainAndStop(old);
    return true;
  }

  private async drainAndStop(old: InstanceLike): Promise<void> {
    const pollMs = this.params.drainPollMs ?? 1000;
    const deadline = Date.now() + this.params.maxDrainSeconds * 1000;
    while (Date.now() < deadline) {
      if (this.params.relay.countConnectionsTo(old.proxyInboundPort) <= 0) break;
      await Bun.sleep(pollMs);
    }
    try { await old.stop(); } catch {}
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/singbox/orchestrator.test.ts`
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add src/singbox/orchestrator.ts src/singbox/orchestrator.test.ts
git commit -m "feat: add blue-green instance orchestrator with graceful drain"
```

**Done check:** 就绪后才切上游、就绪失败保留旧实例、排空到 0 或超时硬关、exclude=旧端口。满足 best-proxy-gateway spec「节点更新期间代理高可用」「新实例就绪后才切换上游」「蓝绿切换优雅排空旧连接」。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Task 9: monitor — best 变化切 selector + 节点集变化触发蓝绿

实现 tasks.md §4.3 + §5.4。Design Doc §4「best 切换」、§5「触发」。

**Files:**
- Modify: `src/monitor.ts`
- Test: `src/monitor.test.ts`（扩展）

**Interfaces:**
- Consumes: `ClashClient.setSelector`（按 `{ setSelector(tag): Promise<void> }` mock）、orchestrator（按 `{ blueGreenSwap(nodes): Promise<boolean> }` mock）、`score`/可用定义（已存在）。
- Produces: `MonitorOptions` 新增可选字段
  ```typescript
  clash?: { setSelector(outboundTag: string): Promise<void> };
  orchestrator?: { blueGreenSwap(newNodes: Node[]): Promise<boolean> };
  onActiveInstance?: (portMap: Map<string, number>, clash: { setSelector(t: string): Promise<void> }) => void;
  ```
  以及方法 `computeBestKey(): Promise<string | null>`、内部 `currentBestKey: string | null`。best 变化 → `clash.setSelector('out-<bestKey>')`；无可用 → `setSelector('block')`，仅在变化时调用。`maybeRefresh` 命中刷新时改调 `orchestrator.blueGreenSwap(newNodes)`（替换原直接 `refresh()` 的 restart 路径）；集合未变不 swap。

- [x] **Step 1: 写失败测试 — best 变化切 selector**

在 `src/monitor.test.ts` 追加（复用文件内 `makeNode`/`MemoryStateStore`/`makePortMap`）：

```typescript
describe('Monitor selector switching', () => {
  function clashSpy() {
    const calls: string[] = [];
    return { calls, client: { async setSelector(t: string) { calls.push(t); } } };
  }

  it('switches selector to the best node outbound when best changes', async () => {
    const store = new MemoryStateStore();
    const a = makeNode('aaa');
    const b = makeNode('bbb');
    // a fast (low latency), b slow -> best is a
    await store.setState('aaa', { latency: 10, failCount: 0, successCount: 1, lastCheck: Date.now(), name: 'a', protocol: 'trojan', server: 'h', port: 1 }, 1000);
    await store.setState('bbb', { latency: 999, failCount: 0, successCount: 1, lastCheck: Date.now(), name: 'b', protocol: 'trojan', server: 'h', port: 2 }, 1000);
    const spy = clashSpy();
    const monitor = new Monitor({
      store, probe: async () => ({ ok: true, latencyMs: 10 }),
      refresh: async () => [a, b], nodes: [a, b], portMap: makePortMap([a, b]),
      intervalSeconds: 9999, maxConcurrency: 10, refreshThreshold: 0.1, refreshCooldownSeconds: 9999,
      nodeTtlSeconds: 1000, deathThreshold: 100, revivalSeconds: 1000,
      testUrl: 't', probeTimeoutMs: 100, clash: spy.client,
    });
    await monitor.runRound();
    expect(spy.calls.at(-1)).toBe('out-aaa');
  });

  it('sets selector to block when no node is available', async () => {
    const store = new MemoryStateStore();
    const a = makeNode('aaa');
    const spy = clashSpy();
    const monitor = new Monitor({
      store, probe: async () => ({ ok: false, latencyMs: 5000 }),
      refresh: async () => [a], nodes: [a], portMap: makePortMap([a]),
      intervalSeconds: 9999, maxConcurrency: 10, refreshThreshold: 0.0001, refreshCooldownSeconds: 9999,
      nodeTtlSeconds: 1000, deathThreshold: 100, revivalSeconds: 1000,
      testUrl: 't', probeTimeoutMs: 100, clash: spy.client,
    });
    await monitor.runRound();
    expect(spy.calls.at(-1)).toBe('block');
  });

  it('does not call setSelector again when best is unchanged', async () => {
    const store = new MemoryStateStore();
    const a = makeNode('aaa');
    await store.setState('aaa', { latency: 10, failCount: 0, successCount: 1, lastCheck: Date.now(), name: 'a', protocol: 'trojan', server: 'h', port: 1 }, 1000);
    const spy = clashSpy();
    const monitor = new Monitor({
      store, probe: async () => ({ ok: true, latencyMs: 10 }),
      refresh: async () => [a], nodes: [a], portMap: makePortMap([a]),
      intervalSeconds: 9999, maxConcurrency: 10, refreshThreshold: 0.1, refreshCooldownSeconds: 9999,
      nodeTtlSeconds: 1000, deathThreshold: 100, revivalSeconds: 1000,
      testUrl: 't', probeTimeoutMs: 100, clash: spy.client,
    });
    await monitor.runRound();
    await monitor.runRound();
    expect(spy.calls.filter((c) => c === 'out-aaa').length).toBe(1);
  });
});

describe('Monitor blue-green trigger', () => {
  it('calls blueGreenSwap with new nodes when node set changes on refresh', async () => {
    const store = new MemoryStateStore();
    const oldNodes = Array.from({ length: 4 }, (_, i) => makeNode(`o${i}`));
    const newNodes = Array.from({ length: 4 }, (_, i) => makeNode(`x${i}`));
    let swapArg: Node[] | null = null;
    const orchestrator = { async blueGreenSwap(n: Node[]) { swapArg = n; return true; } };
    const monitor = new Monitor({
      store, probe: async () => ({ ok: false, latencyMs: 5000 }),
      refresh: async () => newNodes, nodes: oldNodes, portMap: makePortMap(oldNodes),
      intervalSeconds: 9999, maxConcurrency: 10, refreshThreshold: 0.1, refreshCooldownSeconds: 0,
      nodeTtlSeconds: 1000, deathThreshold: 100, revivalSeconds: 1000,
      testUrl: 't', probeTimeoutMs: 100, orchestrator,
    });
    await monitor.runRound();
    expect(swapArg).not.toBeNull();
    expect(swapArg!.map((n) => n.key).sort()).toEqual(['x0', 'x1', 'x2', 'x3']);
  });

  it('does not swap when the refreshed node set is identical', async () => {
    const store = new MemoryStateStore();
    const nodes = Array.from({ length: 4 }, (_, i) => makeNode(`s${i}`));
    let swapCount = 0;
    const orchestrator = { async blueGreenSwap() { swapCount++; return true; } };
    const monitor = new Monitor({
      store, probe: async () => ({ ok: false, latencyMs: 5000 }),
      refresh: async () => nodes, nodes, portMap: makePortMap(nodes),
      intervalSeconds: 9999, maxConcurrency: 10, refreshThreshold: 0.1, refreshCooldownSeconds: 0,
      nodeTtlSeconds: 1000, deathThreshold: 100, revivalSeconds: 1000,
      testUrl: 't', probeTimeoutMs: 100, orchestrator,
    });
    await monitor.runRound();
    expect(swapCount).toBe(0);
  });
});
```

需在 `monitor.test.ts` 顶部确保 `import type { Node } from './types.ts';` 已存在（当前已 import）。

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/monitor.test.ts`
Expected: FAIL（`clash`/`orchestrator` 选项未被使用，selector/swap 从不调用）。

- [x] **Step 3: 实现 monitor 改动**

`MonitorOptions` 加可选字段：

```typescript
  clash?: { setSelector(outboundTag: string): Promise<void> };
  orchestrator?: { blueGreenSwap(newNodes: Node[]): Promise<boolean> };
  onActiveInstance?: (portMap: Map<string, number>, clash: { setSelector(t: string): Promise<void> }) => void;
```

`Monitor` 加字段 `private currentBestKey: string | null = null;`。

在 `runRound` 的 `await this.queue.addAll(checkTasks);` 之后、`if (!skipRefreshCheck)` 之前，插入 best 评估：

```typescript
    await this.applyBestSelector();
```

新增方法：

```typescript
  private async computeBestKey(): Promise<string | null> {
    const { store } = this.opts;
    const now = Date.now();
    let bestKey: string | null = null;
    let bestScore = Infinity;
    for (const node of this.nodes) {
      if (await store.isDead(node.key)) continue;
      const state = await store.getState(node.key);
      if (!state || state.lastCheck === 0 || state.failCount !== 0) continue;
      const s = score(state, now);
      if (s < bestScore) { bestScore = s; bestKey = node.key; }
    }
    return bestKey;
  }

  private async applyBestSelector(): Promise<void> {
    const clash = this.opts.clash;
    if (!clash) return;
    const bestKey = await this.computeBestKey();
    const target = bestKey ? `out-${bestKey}` : 'block';
    const prev = this.currentBestKey;
    const prevTarget = prev ? `out-${prev}` : (prev === null && this.bestApplied ? 'block' : null);
    // Only switch on change.
    if (target === this.lastSelector) return;
    this.lastSelector = target;
    this.currentBestKey = bestKey;
    try { await clash.setSelector(target); } catch (e) { console.error('[monitor] setSelector failed', e); }
  }
```

为简化「仅变化时调用」，用单一 `private lastSelector: string | null = null;` 字段记录上次实际下发的 selector 字符串；删除上面草稿里的 `prevTarget/bestApplied`，最终 `applyBestSelector` 为：

```typescript
  private lastSelector: string | null = null;

  private async applyBestSelector(): Promise<void> {
    const clash = this.opts.clash;
    if (!clash) return;
    const bestKey = await this.computeBestKey();
    const target = bestKey ? `out-${bestKey}` : 'block';
    if (target === this.lastSelector) return;
    this.lastSelector = target;
    this.currentBestKey = bestKey;
    try { await clash.setSelector(target); }
    catch (e) { console.error('[monitor] setSelector failed', e); }
  }
```

需在 `import` 处加 `import { score } from './scoring.ts';`（monitor 当前未 import score）。

改 `maybeRefresh`：把命中刷新分支替换为蓝绿触发并按 key 集合判定是否变化。原：

```typescript
    if (available < total * refreshThreshold) {
      this.lastRefreshAt = nowSec;
      const newNodes = await refresh();
      this.nodes = newNodes;
      await this.runRound(true);
    }
```

改为：

```typescript
    if (available < total * refreshThreshold) {
      this.lastRefreshAt = nowSec;
      const newNodes = await refresh();
      const changed = !this.sameNodeSet(this.nodes, newNodes);
      this.nodes = newNodes;
      if (changed && this.opts.orchestrator) {
        const ok = await this.opts.orchestrator.blueGreenSwap(newNodes);
        if (!ok) console.error('[monitor] blueGreenSwap failed; keeping old instance');
      }
      await this.runRound(true);
    }
```

加辅助方法：

```typescript
  private sameNodeSet(a: Node[], b: Node[]): boolean {
    if (a.length !== b.length) return false;
    const sa = new Set(a.map((n) => n.key));
    for (const n of b) if (!sa.has(n.key)) return false;
    return true;
  }
```

注意：`refresh()` 当前在 `index.ts` 内做 `singbox.restart` + `monitor.updateNodes`。Task 11 会把 `refresh` 改为纯「拉取+解析新节点」，restart 逻辑移交 orchestrator。monitor 侧本 task 已不依赖 refresh 内部行为，只用其返回值。

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/monitor.test.ts`
Expected: PASS。

- [x] **Step 5: 跑全量测试**

Run: `bun test`
Expected: 全 PASS。

- [x] **Step 6: Commit**

```bash
git add src/monitor.ts src/monitor.test.ts
git commit -m "feat: monitor switches selector on best-change and triggers blue-green on node-set change"
```

**Done check:** best 变切 `out-<key>`、无可用切 `block`、不变不重复下发；节点集变触发 `blueGreenSwap`、不变不触发。满足 best-proxy-gateway spec「基于评分的 best 节点热切换」「best 切换不重启进程」与高可用触发侧。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Task 10: GET /proxy API

实现 tasks.md §6.1。Design Doc §6。

**Files:**
- Modify: `src/api.ts`
- Test: `src/api.test.ts`（扩展）

**Interfaces:**
- Consumes: `Monitor.getNodes`、`StateStore`、`score`（已存在）、Task 2 的 best 计算逻辑。
- Produces: `registerRoutes` 新增可选第四参 `proxyInfo`：
  ```typescript
  export interface ProxyInfo { publicHost: string; port: number; }
  export function registerRoutes(app: Elysia, monitor: Monitor, store: StateStore, proxyInfo?: ProxyInfo): Elysia;
  ```
  `GET /proxy` 有 best → `{ proxy: 'http://<host>:<port>', node: <NodeView 含 raw+originalUri> }`；无可用 → `{ proxy: null, node: null }`。`<host>` 取 `proxyInfo.publicHost` 非空否则请求 `Host` 头的主机名否则 `127.0.0.1`。

- [x] **Step 1: 写失败测试**

在 `src/api.test.ts` 追加（复用文件内 `makeNode`/`makeState`/`fakeStore`/`fakeMonitor`/`getJson`）：

```typescript
import { registerRoutes as _rr } from './api.ts'; // already imported; keep single import in file

describe('GET /proxy', () => {
  it('returns the fixed proxy address and best node when a node is available', async () => {
    const node = makeNode('best1');
    const app = registerRoutes(
      new Elysia(), fakeMonitor([node]), fakeStore({ best1: makeState({ latency: 5 }) }),
      { publicHost: 'gw.example.com', port: 8080 },
    );
    const body = await getJson(app, '/proxy');
    expect(body.proxy).toBe('http://gw.example.com:8080');
    expect(body.node.key).toBe('best1');
    expect(body.node.raw.password).toBe('pw-best1');
    expect(body.node.originalUri).toBe('trojan://pw-best1@h.com:443#N-best1');
  });

  it('returns nulls when no node is available', async () => {
    const node = makeNode('dead1');
    const app = registerRoutes(
      new Elysia(), fakeMonitor([node]),
      fakeStore({ dead1: makeState({ failCount: 3 }) }), // failCount!=0 -> unavailable
      { publicHost: 'gw.example.com', port: 8080 },
    );
    const body = await getJson(app, '/proxy');
    expect(body.proxy).toBeNull();
    expect(body.node).toBeNull();
  });

  it('falls back to the request Host when publicHost is empty', async () => {
    const node = makeNode('best2');
    const app = registerRoutes(
      new Elysia(), fakeMonitor([node]), fakeStore({ best2: makeState() }),
      { publicHost: '', port: 9000 },
    );
    const res = await app.handle(new Request('http://my-host:1234/proxy'));
    const body = await res.json();
    expect(body.proxy).toBe('http://my-host:9000');
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/api.test.ts`
Expected: FAIL（无 `/proxy` 路由、`registerRoutes` 无第四参）。

- [x] **Step 3: 实现 /proxy**

`src/api.ts` 顶部加导出：

```typescript
export interface ProxyInfo { publicHost: string; port: number; }
```

`registerRoutes` 签名改为：

```typescript
export function registerRoutes(
  app: Elysia,
  monitor: Monitor,
  store: StateStore,
  proxyInfo?: ProxyInfo,
): Elysia {
```

在 `return app;` 之前插入：

```typescript
  // GET /proxy — stable proxy address + current best node (full info)
  app.get('/proxy', async ({ request }) => {
    const nodes = monitor.getNodes();
    const now = Date.now();
    const entries = await Promise.all(
      nodes.map(async (node) => {
        const [dead, state] = await Promise.all([store.isDead(node.key), store.getState(node.key)]);
        return { node, dead, state };
      }),
    );

    let best: NodeView | null = null;
    let bestScore = Infinity;
    for (const { node, dead, state } of entries) {
      if (dead || !state || state.lastCheck === 0 || state.failCount !== 0) continue;
      const s = score(state, now);
      if (s < bestScore) {
        bestScore = s;
        best = {
          key: node.key, name: node.name, protocol: node.protocol, server: node.server, port: node.port,
          latency: state.latency, failCount: state.failCount, lastCheck: state.lastCheck, score: s,
          raw: node.raw, originalUri: node.originalUri,
        };
      }
    }

    if (!best) return { proxy: null, node: null };

    const port = proxyInfo?.port ?? 8080;
    let host = proxyInfo?.publicHost ?? '';
    if (!host) {
      try { host = new URL(request.url).hostname || '127.0.0.1'; }
      catch { host = '127.0.0.1'; }
    }
    return { proxy: `http://${host}:${port}`, node: best };
  });
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/api.test.ts`
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add src/api.ts src/api.test.ts
git commit -m "feat: add GET /proxy returning stable proxy address and best node"
```

**Done check:** `/proxy` 有 best 返回地址+完整 NodeView，无可用返回 `{proxy:null,node:null}`。满足 best-proxy-gateway spec「查询稳定代理地址 API」。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Task 11: index.ts 装配 relay + orchestrator + clash 生命周期

实现 tasks.md §6.2。Design Doc §1（依赖方向）、§5（触发）。

**Files:**
- Modify: `src/index.ts`
- Modify: `src/api.ts`（已在 Task 10 接受 proxyInfo；此处传入）

**Interfaces:**
- Consumes: `SingBoxInstance`（Task 7）、`InstanceOrchestrator`（Task 8）、`TcpRelay`（Task 6）、`Monitor`（Task 9 新选项）、`registerRoutes(..., proxyInfo)`（Task 10）、`config`（Task 1）。
- 装配关系（Design Doc §1）：`index` 创建 relay、首个 `SingBoxInstance`、orchestrator；monitor 拿到 `active.clash`、orchestrator、`onActiveInstance` 回调；`refresh` 改为纯拉取解析。

此 task 无独立单测（纯装配）；验证靠 `bun test` 不回归 + `bun build`/类型通过 + Task 12 e2e。但 step 内仍要求一次「冒烟启动」证据。

- [x] **Step 1: 重写 main 装配**

将 `src/index.ts` 的 `main()` 改为如下结构（替换 sing-box 启动、refresh、monitor 构造、registerRoutes、lifecycle 部分）：

```typescript
import { Elysia } from 'elysia';
import { loadConfig } from './config.ts';
import { createRedisStore } from './store/state-store.ts';
import { SingBoxInstance } from './singbox/instance.ts';
import { InstanceOrchestrator } from './singbox/orchestrator.ts';
import { TcpRelay } from './relay.ts';
import { fetchSubscription } from './subscription/fetch.ts';
import { parseSubscription } from './subscription/parse.ts';
import { Monitor } from './monitor.ts';
import { registerRoutes } from './api.ts';
import type { Node } from './types.ts';

async function main() {
  const config = loadConfig();
  const store = createRedisStore(config.redisUrl);

  console.log(`[init] Fetching subscription from ${config.subscriptionUrl}`);
  const nodes = parseSubscription(await fetchSubscription(config.subscriptionUrl));
  console.log(`[init] Parsed ${nodes.length} nodes`);

  // Instance factory: blue/green alternate base ports via stride.
  let instanceGen = 0;
  const createInstance = (instNodes: Node[], exclude: Set<number>): SingBoxInstance => {
    const gen = instanceGen++;
    const stride = config.singboxInstancePortStride;
    return new SingBoxInstance({
      binPath: config.singboxBin,
      nodes: instNodes,
      basePort: config.singboxBasePort + (gen % 2) * stride,
      proxyInboundOffset: config.singboxProxyInboundOffset,
      clashPort: config.clashApiBasePort + (gen % 2),
      clashSecret: config.clashApiSecret,
      readyTimeoutMs: config.instanceReadyTimeoutMs,
      exclude,
      portStride: stride,
    });
  };

  // First instance.
  const first = createInstance(nodes, new Set());
  await first.start();
  if (!(await first.ready())) {
    throw new Error('[init] first sing-box instance failed readiness');
  }
  console.log(`[init] sing-box ready: in-proxy=${first.proxyInboundPort} clash=${first.clashPort}`);

  // Always-on relay pointing at the first instance's in-proxy port.
  const relay = new TcpRelay({
    bindAddress: config.proxyBindAddress,
    port: config.proxyPort,
    initialUpstreamPort: first.proxyInboundPort,
  });
  relay.start();
  console.log(`[init] relay listening on ${config.proxyBindAddress}:${config.proxyPort}`);

  // Monitor needs a mutable handle to the active instance's clash + portMap.
  let activeClash = first.clash;
  const monitor = new Monitor({
    store,
    probe: (await import('./singbox/probe.ts')).probe,
    refresh: async () =>
      parseSubscription(await fetchSubscription(config.subscriptionUrl)),
    nodes,
    portMap: first.portMap,
    intervalSeconds: config.checkIntervalSeconds,
    maxConcurrency: config.maxConcurrency,
    refreshThreshold: config.refreshThreshold,
    refreshCooldownSeconds: config.refreshCooldownSeconds,
    nodeTtlSeconds: config.nodeTtlSeconds,
    deathThreshold: config.deathThreshold,
    revivalSeconds: config.revivalSeconds,
    testUrl: config.testUrl,
    probeTimeoutMs: config.probeTimeoutMs,
    clash: { setSelector: (t) => activeClash.setSelector(t) },
    orchestrator: undefined, // set after orchestrator is constructed
  });

  const orchestrator = new InstanceOrchestrator({
    relay,
    initial: first,
    createInstance,
    maxDrainSeconds: config.maxDrainSeconds,
    onActiveChange: (inst) => {
      // Re-point monitor's portMap + clash at the new active instance.
      activeClash = (inst as SingBoxInstance).clash;
      monitor.updateNodes(monitor.getNodes(), (inst as SingBoxInstance).portMap);
    },
  });
  // Wire orchestrator into monitor (mutable opts).
  (monitor as unknown as { opts: { orchestrator: typeof orchestrator } }).opts.orchestrator = orchestrator;

  const app = new Elysia();
  registerRoutes(app, monitor, store, { publicHost: config.proxyPublicHost, port: config.proxyPort });

  app.onStart(async () => {
    console.log('[monitor] Starting health check scheduler...');
    void monitor.start();
  });
  app.onStop(async () => {
    monitor.stop();
    relay.stop();
    await orchestrator.active.stop();
  });

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] received ${signal}, cleaning up...`);
    monitor.stop();
    relay.stop();
    await orchestrator.active.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  app.listen(3000);
  console.log(`[api] Listening on http://localhost:3000`);
}

main().catch((err: unknown) => {
  console.error('[fatal]', err);
  process.exit(1);
});
```

说明：
- `monitor.opts` 当前是 `private readonly opts`。为允许装配后注入 orchestrator，把 `monitor.ts` 中 `private readonly opts` 改为 `private opts`（去掉 `readonly`），并在 `MonitorOptions.orchestrator` 为可选。上面用类型断言访问；若不愿用断言，可在 `Monitor` 暴露 `setOrchestrator(o)` 方法（更干净，推荐）：

```typescript
  setOrchestrator(o: { blueGreenSwap(newNodes: Node[]): Promise<boolean> }) {
    this.opts.orchestrator = o;
  }
```

  并把 index 改成 `monitor.setOrchestrator(orchestrator);`。本计划采用 `setOrchestrator` 方案，删除上面的断言行。

- `onActiveChange` 里把 monitor 的 portMap 重新指向新实例。`Monitor.updateNodes(nodes, portMap)` 已存在。

- [x] **Step 2: 在 monitor.ts 加 setOrchestrator 并放开 opts**

`src/monitor.ts`：构造函数把 `private readonly opts` 改 `private opts`；加方法：

```typescript
  setOrchestrator(o: { blueGreenSwap(newNodes: Node[]): Promise<boolean> }) {
    this.opts.orchestrator = o;
  }
```

把 index Step 1 中的断言行替换为 `monitor.setOrchestrator(orchestrator);`。

- [x] **Step 3: 跑全量测试确认无回归**

Run: `bun test`
Expected: 全 PASS。

- [x] **Step 4: 类型/构建冒烟**

Run: `bun build src/index.ts --target=bun --outfile=/tmp/smartnode-build.js`
Expected: 构建成功（无类型/解析错误）。删除产物：`rm -f /tmp/smartnode-build.js`。

- [x] **Step 5: Commit**

```bash
git add src/index.ts src/monitor.ts
git commit -m "feat: wire relay, blue-green orchestrator and clash lifecycle in index"
```

**Done check:** 启动建首个实例+relay+orchestrator，monitor 持 active clash 与 orchestrator，refresh 只拉解析、蓝绿由 orchestrator 接管。满足 best-proxy-gateway spec「固定转发代理入口」装配侧。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Task 12: 端到端验证与 README

实现 tasks.md §7.1 + §7.2。Design Doc §8（e2e 冒烟,非阻塞）。

**Files:**
- Modify: `README.md`
- (可选) Create: `scripts/e2e-smoke.md` 或在 README 内记录手动 e2e 步骤

**Interfaces:** 无新代码接口。

- [x] **Step 1: 手动 e2e 冒烟（非阻塞,记录结果）**

前置：本机有可用 sing-box 二进制（`SINGBOX_BIN`）、可达 Redis、有效 `SUBSCRIPTION_URL`。执行：

```bash
# 终端 A：占用一个起始端口段内的端口，制造端口冲突
bun -e "Bun.listen({hostname:'127.0.0.1',port:30000,socket:{data(){}}}); setInterval(()=>{},1e9)"

# 终端 B：启动服务
SUBSCRIPTION_URL=... REDIS_URL=redis://127.0.0.1:6379 bun run src/index.ts
```

验证点（逐一记录 PASS/FAIL）：
1. 服务启动不因 30000 被占用而失败（端口跳过生效）。
2. `curl -s localhost:3000/nodes | jq '.nodes[0] | {raw, originalUri}'` 含完整字段。
3. `curl -s localhost:3000/proxy | jq` 返回 `proxy` 地址 + best `node`。
4. Python 经固定代理出网：
   ```bash
   PROXY=$(curl -s localhost:3000/proxy | jq -r .proxy)
   python3 -c "import os,urllib.request; \
     p=os.environ['P']; \
     h={'http':p,'https':p}; \
     o=urllib.request.build_opener(urllib.request.ProxyHandler(h)); \
     print(o.open('https://http://cp.cloudflare.com').status)" P="$PROXY"
   ```
   预期打印 `204`。
5. 刷新期间不中断：开一个长连接（如 `while true; do curl -s -x "$PROXY" https://http://cp.cloudflare.com -o /dev/null -w "%{http_code}\n"; sleep 1; done`），手动触发刷新（让可用比例跌破阈值或重启订阅源），观察循环不出现连接被拒/中断窗口。

若任一 CRITICAL 项（1、4、5）失败 → 加载 systematic-debugging 定位根因后修对应 task，再回到本步。e2e 本身不写自动化断言（非阻塞）。

- [x] **Step 2: 更新 README**

在 `README.md` 增补：
- 新配置项表（§7 全部变量 + 默认值 + 说明）。
- `GET /proxy` 用法与返回示例（有 best / 无可用两种）。
- Python 经固定代理示例（同上 step 的 Python 片段，整理为可复制块）。
- Docker 两端口暴露说明：除原 API 端口 `3000` 外，新增暴露 `PROXY_PORT`（默认 8080），示例 `-p 3000:3000 -p 8080:8080`；并说明 `PROXY_BIND_ADDRESS=0.0.0.0`、`PROXY_PUBLIC_HOST` 的部署含义与 Clash API 仅 127.0.0.1 + secret 的安全说明（Design Doc §9）。

- [x] **Step 3: 跑全量测试做最终回归**

Run: `bun test`
Expected: 全 PASS。

- [x] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document proxy config, /proxy usage, python example and docker ports"
```

**Done check:** e2e 五项验证有记录（CRITICAL 项 PASS）；README 覆盖新配置、`/proxy`、Python 示例、Docker 两端口。满足 tasks.md §7。

archived-with: 2026-06-28-add-best-proxy-gateway
---

## Self-Review

**1. Spec coverage（逐需求映射）**

node-health-monitor spec：
- 「查询接口返回完整节点信息」（/nodes、/nodes/best 含 raw+originalUri）→ Task 2。
- 「sing-box 本地端口分配跳过占用」（探测+跳过+portMap 一致）→ Task 3（分配）+ Task 4（buildConfig 用之、portMap 记录实际）+ Task 7（启动失败回退）。

best-proxy-gateway spec：
- 「固定转发代理入口」→ Task 6（relay）+ Task 11（装配,绑定可配地址/端口,刷新期间地址不变）。
- 「基于评分的 best 节点热切换」「best 切换不重启进程」→ Task 4（selector+clash_api 配置）+ Task 5（ClashClient）+ Task 9（monitor 热切,不重启）。
- 「节点更新期间代理高可用」「新实例就绪后才切换上游」→ Task 7（ready）+ Task 8（orchestrator）+ Task 11。
- 「切换不中断已建立连接」selector 侧（`interrupt_exist_connections:false`）→ Task 4；蓝绿优雅排空侧 → Task 6（relay 保留旧连接）+ Task 8（drain+超时硬关）。
- 「查询稳定代理地址 API」（/proxy 有/无可用两种响应）→ Task 10。

tasks.md 分组：1→Task 1；2→Task 2；3→Task 3/4/7；4→Task 4/5/9；5→Task 6/7/8/9；6→Task 10/11；7→Task 12。全覆盖。

**2. Placeholder scan**：无 TODO/TBD；每个改码步骤含完整代码或精确 diff 指令。Task 9 草稿里先给了含 `prevTarget/bestApplied` 的过渡版，紧接着用最终 `lastSelector` 版替换并明确「删除草稿字段」——实现者以最终版为准。Task 11 同样明确采用 `setOrchestrator` 方案并要求删断言行。

**3. Type consistency**：
- selector tag 全程 `proxy-select`（Task 4 配置、Task 5 ClashClient PUT、Task 9 setSelector 调用一致）。
- block tag `block`，无可用时 `setSelector('block')`（Task 4/9 一致）。
- 出站 tag `out-<key>`（outbound.ts 已有、buildConfig、monitor 一致）。
- `buildConfig` 新签名 `(params)` async，调用方仅 SingBoxInstance（Task 7）与过渡桩 process.ts（Task 7 Step 5 同步更新）。
- `NodeView` 含 `raw`+`originalUri`，三处构造点（/nodes、/nodes/best、/proxy）均补齐（Task 2、Task 10）。
- relay 接口 `setUpstream`/`countConnectionsTo`/`proxyInboundPort` 在 Task 6 定义、Task 8 RelayLike/InstanceLike 消费一致。
- orchestrator `blueGreenSwap(newNodes): Promise<boolean>` 在 Task 8 定义、Task 9 monitor 选项与 Task 11 setOrchestrator 一致。

无残留不一致。计划完成。
