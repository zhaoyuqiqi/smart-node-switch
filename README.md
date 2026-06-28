# smart-node-switch

一个基于 Bun + Elysia + sing-box 的代理网关服务：自动拉取订阅节点，使用 sing-box 原生 `urltest` 自动选优，并通过固定代理端口对外提供稳定访问。

## 功能

- 支持 `trojan` / `vmess` / `ss` / `vless` 订阅解析
- 使用 sing-box 原生 `urltest` 自动选择当前最优节点
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

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SUBSCRIPTION_URL` | **必填** | 订阅地址（base64 或明文行格式） |
| `CHECK_INTERVAL_SECONDS` | `30` | 轮询周期（秒） |
| `REFRESH_THRESHOLD` | `0.1` | 可用性占比阈值（低于触发刷新） |
| `REFRESH_COOLDOWN_SECONDS` | `300` | 刷新最小间隔（秒） |
| `TEST_URL` | `https://www.google.com` | `urltest` 探测目标 |
| `SINGBOX_BASE_PORT` | `30000` | sing-box 端口段起点 |
| `SINGBOX_BIN` | `src/sing-box/sing-box` | sing-box 二进制路径 |
| `PROXY_PORT` | `8080` | 对外固定代理端口 |
| `PROXY_BIND_ADDRESS` | `0.0.0.0` | relay 监听地址 |
| `PROXY_PUBLIC_HOST` | `''` | `/proxy` 返回地址中的 host（空则回退请求 Host） |
| `PROXY_AUTH_USER` | `''` | 代理鉴权用户名（与 `PROXY_AUTH_PASS` 同时设置才生效） |
| `PROXY_AUTH_PASS` | `''` | 代理鉴权密码（与 `PROXY_AUTH_USER` 同时设置才生效） |
| `CLASH_API_BASE_PORT` | `9090` | clash API 基址（蓝绿偏移） |
| `CLASH_API_SECRET` | 启动时随机 | clash API 鉴权 secret |
| `SINGBOX_INSTANCE_PORT_STRIDE` | `1000` | 蓝绿实例端口段间隔 |
| `SINGBOX_PROXY_INBOUND_OFFSET` | `0` | in-proxy 端口偏移 |
| `MAX_DRAIN_SECONDS` | `300` | 蓝绿切换旧实例最大排空时长 |
| `INSTANCE_READY_TIMEOUT_MS` | `8000` | 新实例就绪超时 |

## 运行

```bash
SUBSCRIPTION_URL=https://your.sub/link bun run src/index.ts
```

默认 API 地址：`http://localhost:3000`。

## API

### `GET /nodes`

返回当前节点列表（运行时内存状态），包含 `isBest` 标记和 `latencyMs`（最近一次 urltest 延迟，毫秒；无数据时为 `null`）。

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

返回当前 urltest 选中的最优节点；没有可用节点时返回 `{ "best": null }`。

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
resp = requests.get("https://www.google.com", proxies={"http": proxy, "https": proxy})
print(resp.status_code)  # 预期 200
```

如果启用了代理鉴权（`PROXY_AUTH_USER` / `PROXY_AUTH_PASS`）：

```python
import requests

auth_proxy = "http://your-user:your-pass@localhost:8080"
resp = requests.get("https://www.google.com", proxies={"http": auth_proxy, "https": auth_proxy})
print(resp.status_code)  # 预期 200
```

## 测试

```bash
bun run --bun tsc --noEmit
bun test src/
```
