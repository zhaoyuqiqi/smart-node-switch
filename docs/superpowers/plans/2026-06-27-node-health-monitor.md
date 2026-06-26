---
change: add-node-health-monitor
design-doc: docs/superpowers/specs/2026-06-26-node-health-monitor-design.md
base-ref: 6fa3e0d06e036349a461300986e875b964299e6b
---

# Node Health Monitor 实施计划

## 概述

基于 Design Doc 和 tasks.md，将实现一个完整的节点健康监控服务，包含订阅解析、sing-box 代理编排、Redis 状态管理、健康检查调度和 Elysia API。

## 模块划分与执行顺序

任务按依赖顺序分 7 批执行，先基础模块后上层集成。

---

## 第 1 批：项目脚手架与配置（任务 1.1–1.3）

**目标**：建立运行时环境、配置加载、类型系统和 Redis key 规则。

### Task 1.1 — 安装依赖

```bash
bun add elysia ioredis p-queue
# 确认 sing-box 二进制可执行
chmod +x src/sing-box/sing-box
```

### Task 1.2 — 配置加载

创建 `src/config.ts`：
- 读取所有 `.env` 变量（见 Design Doc §8）
- 所有配置项有默认值（`SUBSCRIPTION_URL` 为必填，缺失时抛错退出）
- 导出 `Config` 类型与 `loadConfig()` 函数

### Task 1.3 — 类型定义与 Redis key 规则

创建 `src/types.ts`：
- `Node`、`NodeState`、`NodeView`、`Config` interface
- `nodeKey(node: Omit<Node, 'key' | 'name'>): string`（sha1 前 16 位）
- Redis key helper：`stateKey(key)`, `deadKey(key)`

---

## 第 2 批：订阅解析（任务 2.1–2.6）

**目标**：实现四种协议解析器和聚合入口，每个 parser 含单测。

### Task 2.1 — 订阅拉取与 base64 解码

`src/subscription/fetch.ts`：`fetchSubscription(url): Promise<string[]>`

### Task 2.2 — trojan:// 解析器

`src/subscription/parsers/trojan.ts`：`parseTrojan(uri): Node | null` + 单测

### Task 2.3 — vmess:// 解析器

`src/subscription/parsers/vmess.ts`：`parseVmess(uri): Node | null` + 单测

### Task 2.4 — ss:// 解析器

`src/subscription/parsers/ss.ts`：支持 SIP002 与 base64 变体 + 单测

### Task 2.5 — vless:// 解析器

`src/subscription/parsers/vless.ts`：`parseVless(uri): Node | null` + 单测

### Task 2.6 — 解析聚合

`src/subscription/parse.ts`：`parseSubscription(lines: string[]): Node[]`
- 分发到四个 parser，跳过 null/不支持，生成 nodeKey，去重
- 含单测（base64 解码 + 跳过非法 + key 稳定性）

---

## 第 3 批：sing-box 代理编排（任务 3.1–3.3）

**目标**：Node → outbound 映射、config 生成、进程管理、probe 探测。

### Task 3.1 — outbound 映射

`src/singbox/outbound.ts`：`toOutbound(node: Node): object`（四种协议）+ 单测（期望 JSON）

### Task 3.2 — Config 生成与进程管理

`src/singbox/config.ts`：`buildConfig(nodes, basePort): { config, portMap }`
`src/singbox/process.ts`：`SingBoxProcess`（start/restart/stop）

### Task 3.3 — probe 探测函数

`src/singbox/probe.ts`：`probe(port, testUrl, timeoutMs): Promise<{ ok, latencyMs }>`
- 使用 Bun `fetch` 的 `proxy` 选项，超时用 `AbortSignal.timeout`
- 含单测（mock fetch）

---

## 第 4 批：Redis 状态与评分（任务 4.1–4.4）

**目标**：StateStore 接口 + Redis 实现、评分函数、死亡/复活逻辑。

### Task 4.1 — StateStore 接口与 Redis 实现

`src/store/state-store.ts`：
- `StateStore` interface（read/write/dead/revive/TTL 续期）
- `RedisStateStore`（ioredis，每次写入 `EXPIRE key nodeTtlSeconds`，读后续期）
- 含集成测试（独立 DB index）

### Task 4.2 — 评分函数

`src/scoring.ts`：`score(state: NodeState, now: number): number`
- 公式：`latency * 0.7 + failCount * 100 + (now - lastCheck) * 0.001`
- 含单测（公式正确性，failCount 主导）

### Task 4.3 — 成功重置逻辑

在 `StateStore` 写入层中：`failCount=0` on success
- 含单测

### Task 4.4 — 死亡标记与复活

`dead:<key>` TTL = `revivalSeconds`（24h）；复活后再次失败立即重写 dead key
- 含单测（状态转移：20次失败→dead，成功→复活，再失败→立即dead）

---

## 第 5 批：健康检查调度（任务 5.1–5.4）

**目标**：Monitor 核心调度逻辑。

### Task 5.1 — 周期调度器

`src/monitor.ts`：`Monitor` 类
- 构造时注入 `StateStore`、`probe`（可 mock）、节点列表
- `start()`：立即 `runRound()`，之后每 `intervalSeconds` 重复

### Task 5.2 — 跳过死亡节点并更新状态

`runRound()`：
- 检查 `dead:<key>` 存在性，跳过 dead 节点
- 探测后按成功/失败更新状态并续期

### Task 5.3 — p-queue 并发控制

引入 `PQueue({ concurrency })`，控制最大并发默认 10

### Task 5.4 — 健康占比监测与订阅刷新

`runRound()` 完成后：可用数 < 总数 * `refreshThreshold` 且满足 cooldown → `refreshSubscription()` → 重启 sing-box → 再 `runRound()`
- 含单测（mock probe 编排成功/失败序列，验证 failCount、死亡、刷新触发）

---

## 第 6 批：Elysia API（任务 6.1–6.3）

**目标**：暴露两个 HTTP 接口。

### Task 6.1 — Elysia 服务入口

`src/api.ts`：`registerRoutes(app, monitor, store, nodes)`
`src/index.ts`（主入口）：loadConfig → 初始化 Redis → 启动 Monitor → 挂路由 → listen

### Task 6.2 — GET /nodes

返回 `{ count, nodes: NodeView[] }`，筛选 `failCount===0 && !dead && lastCheck>0`

### Task 6.3 — GET /nodes/best

返回 score 最低的 `NodeView`；无可用节点时返回 `{ best: null }`（HTTP 200）

---

## 第 7 批：集成与收尾（任务 7.1–7.2）

### Task 7.1 — 端到端验证

手动/脚本验证：启动 → 解析订阅 → 周期检查 → 两个 API 返回正确

### Task 7.2 — 更新 README

补充：运行方式、环境变量表、API 说明

---

## 技术约束

- 运行时：Bun（`bun test` 跑测试）
- 不使用 Node.js crypto，改用 Bun 内置 `Bun.CryptoHasher` 生成 sha1
- probe 使用 Bun `fetch` 的 `proxy` 选项（非 Node.js `http` 模块）
- ioredis 直连 Redis，不用连接池抽象层
- sing-box 二进制路径通过 `SINGBOX_BIN` 配置（默认 `src/sing-box/sing-box`）

## 提交策略

每批任务完成后单独提交，commit message 格式：
```
feat(<module>): <描述>
```
例：`feat(subscription): add trojan parser with unit tests`
