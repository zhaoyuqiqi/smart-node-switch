# smart-node-switch

一个基于 Bun + Elysia + sing-box + Redis 的节点健康监控服务。自动拉取代理订阅、周期检测节点延迟与可用性，通过 HTTP API 暴露最优节点。

## 功能

- 支持 trojan / vmess / ss / vless 四种协议订阅解析
- 通过 sing-box 为每个节点分配本地端口，经代理探测真实可用性
- Redis 持久化节点状态（延迟、失败次数、死亡/复活）
- p-queue 控制并发检查数量
- 可用节点占比低时自动刷新订阅
- Elysia HTTP API 暴露可用节点列表与最优节点

## 前置条件

- [Bun](https://bun.com) >= 1.0
- Redis（本地或远程）
- `src/sing-box/sing-box` 可执行二进制（当前架构：macOS x86_64）

## 安装

```bash
bun install
```

## 配置

复制并编辑 `.env`（或直接设置环境变量）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SUBSCRIPTION_URL` | **必填** | 订阅地址（base64 或明文行格式） |
| `CHECK_INTERVAL_SECONDS` | `30` | 健康检查周期（秒） |
| `MAX_CONCURRENCY` | `10` | 最大并发检查数 |
| `REFRESH_THRESHOLD` | `0.1` | 可用节点占比低于此值时触发订阅刷新 |
| `REFRESH_COOLDOWN_SECONDS` | `300` | 两次刷新之间最小间隔（秒） |
| `NODE_TTL_SECONDS` | `172800` | Redis 节点状态 TTL（默认 2 天） |
| `DEATH_THRESHOLD` | `20` | 连续失败多少次标记为死亡 |
| `REVIVAL_SECONDS` | `86400` | 死亡节点复活时长（默认 24h） |
| `TEST_URL` | `http://www.gstatic.com/generate_204` | 探测目标 URL |
| `PROBE_TIMEOUT_MS` | `5000` | 单次探测超时（毫秒） |
| `SINGBOX_BASE_PORT` | `30000` | sing-box 本地 inbound 起始端口 |
| `SINGBOX_BIN` | `src/sing-box/sing-box` | sing-box 二进制路径 |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis 连接地址 |

## 运行

```bash
SUBSCRIPTION_URL=https://your.sub/link bun run src/index.ts
```

服务默认监听 `http://localhost:3000`。

## API

### `GET /nodes`

返回所有当前可用节点（`failCount === 0` 且已完成至少一次检查，且未标记死亡）。

**响应示例：**
```json
{
  "count": 3,
  "nodes": [
    {
      "key": "a1b2c3d4e5f6g7h8",
      "name": "节点名称",
      "protocol": "trojan",
      "server": "example.com",
      "port": 443,
      "latency": 120,
      "failCount": 0,
      "lastCheck": 1719456000000,
      "score": 84.456
    }
  ]
}
```

### `GET /nodes/best`

返回得分最低（综合延迟最优）的可用节点。无可用节点时返回 `{ "best": null }`。

**评分公式：** `latency × 0.7 + failCount × 100 + (now − lastCheck) × 0.001`

**响应示例（有节点）：**
```json
{
  "best": {
    "key": "a1b2c3d4e5f6g7h8",
    "name": "最优节点",
    "protocol": "vmess",
    "server": "1.2.3.4",
    "port": 8080,
    "latency": 85,
    "failCount": 0,
    "lastCheck": 1719456000000,
    "score": 59.5
  }
}
```

**响应示例（无可用节点）：**
```json
{ "best": null }
```

## 测试

```bash
bun test
```

## 项目结构

```
src/
  index.ts              服务入口
  config.ts             配置加载（.env）
  types.ts              数据类型与 Redis key 工具
  scoring.ts            节点评分纯函数
  monitor.ts            健康检查调度器
  api.ts                Elysia HTTP 路由
  subscription/
    fetch.ts            订阅拉取与 base64 解码
    parse.ts            解析聚合
    parsers/            四种协议解析器
  singbox/
    outbound.ts         Node → sing-box outbound 映射
    config.ts           sing-box 配置生成
    process.ts          sing-box 进程管理
    probe.ts            节点可用性探测
  store/
    state-store.ts      StateStore 接口 + Redis 实现
  sing-box/sing-box     sing-box 二进制（macOS x86_64）
```
