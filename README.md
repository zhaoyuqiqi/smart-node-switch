# smart-node-switch

一个基于 Bun + Elysia + sing-box + Redis 的节点健康监控服务。自动拉取代理订阅、周期检测节点延迟与可用性，通过 HTTP API 暴露最优节点。

## 功能

- 支持 trojan / vmess / ss / vless 四种协议订阅解析
- 通过 sing-box 为每个节点分配本地端口，经代理探测真实可用性
- 本地端口分配自动探测并跳过被占用端口（避免端口冲突导致启动失败）
- Redis 持久化节点状态（延迟、失败次数、死亡/复活）
- p-queue 控制并发检查数量
- 可用节点占比低时自动刷新订阅
- Elysia HTTP API 暴露可用节点列表与最优节点（含原始订阅信息 `raw` + `originalUri`）
- **固定转发代理网关**：对外暴露一个稳定的 HTTP/SOCKS 代理端口，内部基于评分热切换到 best 节点；订阅刷新时通过蓝绿实例切换，地址不变、已建立连接不中断
- `GET /proxy` 直接返回可复制的固定代理地址 + 当前 best 节点

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
| `TEST_URL` | `https://www.google.com` | 探测目标 URL |
| `PROBE_TIMEOUT_MS` | `5000` | 单次探测超时（毫秒） |
| `SINGBOX_BASE_PORT` | `30000` | sing-box 本地 inbound 起始端口 |
| `SINGBOX_BIN` | `src/sing-box/sing-box` | sing-box 二进制路径 |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis 连接地址 |
| `PROXY_PORT` | `8080` | 对外固定转发代理端口（relay 监听端口） |
| `PROXY_BIND_ADDRESS` | `0.0.0.0` | relay 绑定地址（容器内须为 `0.0.0.0` 才能对外可达） |
| `PROXY_PUBLIC_HOST` | `''`（空，回退请求 Host 头） | `/proxy` 返回地址使用的对外 host；为空时取请求的 Host 头 |
| `CLASH_API_BASE_PORT` | `9090` | sing-box Clash API 控制口基址（蓝/绿实例各自偏移） |
| `CLASH_API_SECRET` | 随机生成（启动时生成一个无横线 UUID） | Clash API 鉴权 secret；未设置则每次启动随机生成 |
| `SINGBOX_INSTANCE_PORT_STRIDE` | `1000` | 蓝绿两实例端口段间隔 |
| `SINGBOX_PROXY_INBOUND_OFFSET` | `0` | 实例内 in-proxy 入站端口偏移 |
| `MAX_DRAIN_SECONDS` | `300` | 蓝绿切换时旧实例最大优雅排空超时（秒），超时则硬关 |
| `INSTANCE_READY_TIMEOUT_MS` | `8000` | 新实例就绪探测超时（毫秒） |

> 安全说明：固定代理端口（`PROXY_PORT`）**无内置鉴权**，应在网络层（防火墙 / 安全组 / 内网）做访问控制；sing-box 的 Clash API 仅绑定 `127.0.0.1` 并要求 `CLASH_API_SECRET`，不对外暴露。

## 运行

```bash
SUBSCRIPTION_URL=https://your.sub/link bun run src/index.ts
```

服务默认监听 `http://localhost:3000`。

## API

### `GET /nodes`

返回所有当前可用节点（`failCount === 0` 且已完成至少一次检查，且未标记死亡）。

节点对象现在额外包含 `raw`（原始订阅字段解析后的对象）与 `originalUri`（订阅中的原始节点 URI 行）。

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
      "score": 84.456,
      "raw": {
        "type": "trojan",
        "server": "example.com",
        "server_port": 443,
        "password": "********"
      },
      "originalUri": "trojan://********@example.com:443?sni=example.com#%E8%8A%82%E7%82%B9%E5%90%8D%E7%A7%B0"
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
    "score": 59.5,
    "raw": { "type": "vmess", "server": "1.2.3.4", "server_port": 8080 },
    "originalUri": "vmess://eyJ2IjoiMiIsInBzIjoi..."
  }
}
```

**响应示例（无可用节点）：**
```json
{ "best": null }
```

### `GET /proxy`

返回**固定转发代理地址**及当前 best 节点。代理地址在订阅刷新、best 热切换期间保持不变（内部通过蓝绿实例切换上游），可直接配置给客户端长期使用。

- 有可用节点时：`proxy` 为 `http://<host>:<PROXY_PORT>`，`node` 为当前 best 节点（完整 NodeView，含 `raw` + `originalUri`）。
- 无可用节点时：`proxy` 与 `node` 均为 `null`（此时内部 selector 已指向 block，代理连接会立即被拒绝）。

`<host>` 取 `PROXY_PUBLIC_HOST`，为空时回退请求的 `Host` 头。

**响应示例（有可用节点）：**
```json
{
  "proxy": "http://your-host:8080",
  "node": {
    "key": "a1b2c3d4e5f6g7h8",
    "name": "最优节点",
    "protocol": "vmess",
    "server": "1.2.3.4",
    "port": 8080,
    "latency": 85,
    "failCount": 0,
    "lastCheck": 1719456000000,
    "score": 59.5,
    "raw": { "type": "vmess", "server": "1.2.3.4", "server_port": 8080 },
    "originalUri": "vmess://eyJ2IjoiMiIsInBzIjoi..."
  }
}
```

**响应示例（无可用节点）：**
```json
{ "proxy": null, "node": null }
```

### 经固定代理出网（Python 示例）

将 `/proxy` 返回的地址同时设为 http/https 代理即可。该地址在节点热切换/订阅刷新期间稳定不变。

使用 `requests`：

```python
import requests

# 从 /proxy 获取固定代理地址
info = requests.get("http://localhost:3000/proxy").json()
proxy = info["proxy"]                # 例如 "http://your-host:8080"
assert proxy, "当前无可用节点"

proxies = {"http": proxy, "https": proxy}
resp = requests.get("https://www.google.com", proxies=proxies)
print(resp.status_code)              # 预期 200
```

仅用标准库 `urllib`：

```python
import urllib.request

info = urllib.request.urlopen("http://localhost:3000/proxy").read()
proxy = __import__("json").loads(info)["proxy"]   # 例如 "http://your-host:8080"

handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
opener = urllib.request.build_opener(handler)
print(opener.open("https://www.google.com").status)   # 预期 200
```

## Docker 部署

构建并运行时需同时暴露 **API 端口（`3000`）** 与 **固定代理端口（`PROXY_PORT`，默认 `8080`）**：

```bash
docker run -d \
  -e SUBSCRIPTION_URL="https://your.sub/link" \
  -e REDIS_URL="redis://redis-host:6379" \
  -e PROXY_BIND_ADDRESS="0.0.0.0" \
  -e PROXY_PUBLIC_HOST="your-host" \
  -p 3000:3000 \
  -p 8080:8080 \
  smart-node-switch
```

- `PROXY_BIND_ADDRESS=0.0.0.0`：relay 在容器内必须绑定 `0.0.0.0`，否则外部无法访问代理端口。
- `PROXY_PUBLIC_HOST`：设为客户端可达的对外主机名/IP，`/proxy` 会用它拼出可直接使用的代理地址；留空则回退到请求的 `Host` 头。
- **安全**：固定代理端口（`8080`）**无鉴权**，请在网络层（安全组 / 防火墙 / 仅内网暴露）限制访问；sing-box 的 Clash 控制 API 仅绑定 `127.0.0.1` 并要求 `CLASH_API_SECRET`，不随上述端口对外暴露。

## E2E 冒烟（手动）

以下为手动端到端冒烟流程（**非阻塞**，见设计文档 §8）。需要本机具备可用的 sing-box 二进制（`SINGBOX_BIN`）、可达的 Redis，以及有效的 `SUBSCRIPTION_URL`，故不纳入自动化测试门禁——自动化门禁由 `bun test` 负责。

```bash
# 终端 A：占用起始端口段内的一个端口，制造端口冲突
bun -e "Bun.listen({hostname:'127.0.0.1',port:30000,socket:{data(){}}}); setInterval(()=>{},1e9)"

# 终端 B：启动服务
SUBSCRIPTION_URL=... REDIS_URL=redis://127.0.0.1:6379 bun run src/index.ts
```

逐项验证并记录 PASS/FAIL：

1. **端口跳过生效**：服务不因 `30000` 被占用而启动失败（自动跳过占用端口）。
2. **节点完整信息**：`curl -s localhost:3000/nodes | jq '.nodes[0] | {raw, originalUri}'` 含完整 `raw` + `originalUri` 字段。
3. **固定代理地址**：`curl -s localhost:3000/proxy | jq` 返回 `proxy` 地址 + best `node`。
4. **Python 经固定代理出网**（CRITICAL）：

   ```bash
   PROXY=$(curl -s localhost:3000/proxy | jq -r .proxy)
   python3 -c "import os,urllib.request; \
     p=os.environ['P']; \
     h={'http':p,'https':p}; \
     o=urllib.request.build_opener(urllib.request.ProxyHandler(h)); \
     print(o.open('https://www.google.com').status)" P="$PROXY"
   ```

   预期打印 `204`。

5. **刷新期间不中断**（CRITICAL）：开一个长轮询循环，手动触发订阅刷新（让可用比例跌破阈值或重启订阅源），观察循环不出现连接被拒/中断窗口：

   ```bash
   while true; do \
     curl -s -x "$PROXY" https://www.google.com -o /dev/null -w "%{http_code}\n"; \
     sleep 1; \
   done
   ```

CRITICAL 项（1、4、5）必须 PASS。e2e 本身不写自动化断言（非阻塞）；如任一 CRITICAL 失败，应定位根因修复对应实现后重跑。

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
  monitor.ts            健康检查调度器（best 热切换 + 节点集变化触发蓝绿）
  api.ts                Elysia HTTP 路由（/nodes /nodes/best /proxy）
  relay.ts              固定 TCP relay：监听 PROXY_PORT，原子切换上游 + 优雅排空
  subscription/
    fetch.ts            订阅拉取与 base64 解码
    parse.ts            解析聚合
    parsers/            四种协议解析器（保存 originalUri）
  singbox/
    outbound.ts         Node → sing-box outbound 映射
    ports.ts            端口可用性探测 + 跳过占用分配
    config.ts           sing-box 配置生成（selector + block + in-proxy + clash_api）
    instance.ts         sing-box 单实例封装（start/ready/stop）
    process.ts          进程管理
    clash.ts            ClashClient：setSelector / waitReady
    orchestrator.ts     InstanceOrchestrator：active 实例 + blueGreenSwap
    probe.ts            节点可用性探测
  store/
    state-store.ts      StateStore 接口 + Redis 实现
  sing-box/sing-box     sing-box 二进制（macOS x86_64）
```
