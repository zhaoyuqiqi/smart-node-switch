# smart-node-switch

一个基于 Bun + Elysia + sing-box 的代理网关服务：自动拉取订阅节点，使用 sing-box `urltest` 采集 RTT，再由服务端评分系统选择最优节点，并通过固定代理端口对外提供稳定访问。

## 功能

- 支持 `trojan` / `vmess` / `ss` / `vless` 订阅解析
- 使用 sing-box 原生 `urltest` 采集节点 RTT（不直接自动切换）
- 内置评分系统（成功率/中位 RTT/P95/Jitter/连续失败）选择出口节点
- 固定代理入口（`PROXY_PORT`）+ 蓝绿实例切换，刷新期间已建立连接不中断
- 支持可选代理账号密码鉴权（`PROXY_AUTH_USER` + `PROXY_AUTH_PASS`）
- 当无可用节点时，`GET /proxy` 返回 `503`，relay 拒绝新连接
- API 返回节点原始信息：`raw` + `originalUri`

## 前置条件

- [Bun](https://bun.com) >= 1.0
- `src/sing-box/sing-box` 可执行二进制

## 安装

```bash
bun install
```

## Docker 打包与运行

构建镜像：

```bash
docker build -t smart-node-switch:latest .
```

> 镜像内已安装系统 CA 证书（`ca-certificates`），用于 `sing-box` 的 HTTPS/TLS 证书校验。

> 说明：容器运行依赖 `src/sing-box/sing-box`。请确保该文件为 **Linux 可执行** 的 sing-box 二进制。

最小运行示例（仅暴露代理端口）：

```bash
docker run --rm \
  -e SUBSCRIPTION_URL='https://your.sub/link' \
  -e PROXY_AUTH_USER='your-user' \
  -e PROXY_AUTH_PASS='your-pass' \
  -p 8080:8080 \
  smart-node-switch:latest
```

如需查看 API，再额外映射 `3000`：

```bash
docker run --rm \
  -e SUBSCRIPTION_URL='https://your.sub/link' \
  -p 8080:8080 \
  -p 3000:3000 \
  smart-node-switch:latest
```

端口建议：

- 建议只对公网暴露 `8080`（代理入口）。
- `3000`（业务 API）与 `9090`（clash API）尽量仅保留容器内访问。
- 若对公网暴露 `8080`，建议同时设置 `PROXY_AUTH_USER` 与 `PROXY_AUTH_PASS`。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SUBSCRIPTION_URL` | **必填** | 订阅地址（base64 或明文行格式） |
| `CHECK_INTERVAL_SECONDS` | `30` | 轮询周期（秒） |
| `REFRESH_THRESHOLD` | `0.1` | 可用性占比阈值（低于触发刷新） |
| `REFRESH_COOLDOWN_SECONDS` | `300` | 刷新最小间隔（秒） |
| `TEST_URL` | `https://cp.cloudflare.com` | 主动探测与 `urltest` 的探测目标 |
| `URLTEST_INTERVAL` | `3m` | sing-box 内置 `urltest` 轮询间隔（例如 `30s` / `1m`） |
| `PROBE_TIMEOUT_MS` | `5000` | 主动探测单节点超时（毫秒） |
| `ACTIVE_PROBE_INTERVAL_SECONDS` | `60` | 主动探测触发间隔（秒），默认每 1 分钟触发一次 |
| `SINGBOX_BASE_PORT` | `30000` | sing-box 端口段起点 |
| `SINGBOX_BIN` | mac: `src/sing-box/sing-box-mac` / Linux: `src/sing-box/sing-box-linux` | sing-box 二进制路径（可手动覆盖） |
| `PROXY_PORT` | `8080` | 对外固定代理端口 |
| `PROXY_BIND_ADDRESS` | `0.0.0.0` | relay 监听地址 |
| `PROXY_PUBLIC_HOST` | `''` | `/proxy` 返回地址中的 host（空则回退请求 Host） |
| `PROXY_AUTH_USER` | `''` | 代理鉴权用户名（与 `PROXY_AUTH_PASS` 同时设置才生效） |
| `PROXY_AUTH_PASS` | `''` | 代理鉴权密码（与 `PROXY_AUTH_USER` 同时设置才生效） |
| `CLASH_API_BASE_PORT` | `9090` | clash API 基址（蓝绿偏移） |
| `CLASH_API_BIND_ADDRESS` | `127.0.0.1` | clash API 监听地址；Docker 对外暴露时设为 `0.0.0.0` |
| `CLASH_API_SECRET` | 启动时随机 | clash API 鉴权 secret |
| `SINGBOX_INSTANCE_PORT_STRIDE` | `1000` | 蓝绿实例端口段间隔 |
| `SINGBOX_PROXY_INBOUND_OFFSET` | `0` | in-proxy 端口偏移 |
| `MAX_DRAIN_SECONDS` | `300` | 蓝绿切换旧实例最大排空时长 |
| `INSTANCE_READY_TIMEOUT_MS` | `8000` | 新实例就绪超时 |
| `DEBUG_MONITOR` | `false` | 打印评分/测速诊断日志（`1/true` 开启） |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis 连接地址（用于保存节点 RTT 与统计） |
| `REDIS_KEY_PREFIX` | `sns:node-metrics` | Redis key 前缀 |
| `REDIS_NODE_TTL_SECONDS` | `21600` | 每个节点 RTT 列表与统计 Hash 的过期时间（秒，默认 6 小时，写入时自动续期） |

## 运行

```bash
SUBSCRIPTION_URL=https://your.sub/link bun run src/index.ts
```

默认 API 地址：`http://localhost:3000`。

## API

### `GET /nodes`

返回当前节点列表（运行时内存状态），包含 `isBest`、`latencyMs`（最近一次 urltest RTT，毫秒；无数据时为 `null`）、`score` 和 `statistics`（统计信息）。

示例：

```json
{
  "count": 2,
  "nodes": [
    {
      "key": "abc123",
      "name": "node-a",
      "protocol": "trojan",
      "server": "example.com",
      "port": 443,
      "isBest": true,
      "latencyMs": 86,
      "raw": { "password": "***" },
      "originalUri": "trojan://***@example.com:443#node-a"
    }
  ]
}
```

### `GET /nodes/best`

返回当前评分系统选中的最优节点；没有可用节点时返回 `{ "best": null }`。

### `GET /proxy`

返回固定代理地址与当前最优节点：

- 有可用节点：`200`，`{ proxy, node }`
- 无可用节点：`503`，`{ proxy: null, node: null, reason }`

示例（无可用节点）：

```json
{
  "proxy": null,
  "node": null,
  "reason": "no available node from urltest"
}
```

## Python 使用示例

```python
import requests

info = requests.get("http://localhost:3000/proxy")
if info.status_code == 503:
    raise RuntimeError("当前无可用节点")

proxy = info.json()["proxy"]
resp = requests.get("https://http://cp.cloudflare.com", proxies={"http": proxy, "https": proxy})
print(resp.status_code)  # 预期 200
```

如果启用了代理鉴权（`PROXY_AUTH_USER` / `PROXY_AUTH_PASS`）：

```python
import requests

auth_proxy = "http://your-user:your-pass@localhost:8080"
resp = requests.get("https://http://cp.cloudflare.com", proxies={"http": auth_proxy, "https": auth_proxy})
print(resp.status_code)  # 预期 200
```

## 测试

```bash
bun run --bun tsc --noEmit
bun test src/
```
