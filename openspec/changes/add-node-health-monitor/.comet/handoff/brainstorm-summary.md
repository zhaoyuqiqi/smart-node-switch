# Brainstorm Summary

- Change: add-node-health-monitor
- Date: 2026-06-26

## 确认的技术方案

- **sing-box 编排**:单实例 · 一节点一本地端口。常驻一个 sing-box 进程,为每个节点生成一个 `mixed` inbound(listen 127.0.0.1,端口 = basePort+index),route 规则按 inbound tag → 对应节点 outbound tag。健康检查 = `fetch(testURL, { proxy: 'http://127.0.0.1:port', signal: AbortSignal.timeout(ms) })`,测耗时与成败。订阅变化时重新生成配置并重启进程(配置无法稳定热重载)。
- **节点唯一标识**:连接身份哈希。对 `协议+server+port+密码/uuid+关键传输参数` 规范化后 sha1 取前 16 位作为 nodeKey。同 server:port 不同凭证不冲突;节点名(`#tag`)仅展示。
- **新节点/可用性**:节点状态含 `lastCheck`(从未检查=0)。**可用 = lastCheck>0 且 failCount===0**(至少检查过一次且最近一次成功)。评分只对可用节点算,新节点不参与,避免 `(now-lastCheck)` 失真。
- **刷新判定时机**:仅在每轮检查完成后评估 `可用数/总数 < 阈值(默认10%)`;启动先跑一轮,不会被「初始 0 可用」瞬间触发。刷新带 cooldown 防抖,避免持续不可用时频繁拉订阅。
- **死亡/复活**:failCount 连续累加,达到阈值(默认20)写 dead key(TTL=复活时长默认24h)。dead 节点 failCount≥20 → 自然不可用;dead key 过期即复活恢复检查;一次成功 → failCount=0 恢复可用;复活后仍失败(failCount≥20)→ 立即再标记 dead。
- **Redis TTL**:节点状态 key 写入设 2 天过期,每次操作续期 2 天;dead key 独立 24h TTL。
- **并发**:p-queue,concurrency 默认 10。
- **依赖/运行时**:Bun + Elysia + ioredis + p-queue + 内置 sing-box。配置走 .env。

## 关键取舍与风险

- 一节点一端口 → 节点多时监听口多,但 sing-box 可承受,换取静态配置与稳定性(避免热重载)。
- 订阅刷新需 cooldown,否则持续低可用会反复拉订阅。
- sing-box 二进制 darwin/amd64,跨平台部署需匹配架构。
- 经代理 fetch 依赖 Bun 的 fetch proxy 支持;probe 函数收口,便于替换/测试。

## 测试策略

- 纯逻辑单测(bun test):4 协议解析器、base64 订阅聚合(跳过非法)、评分函数、failCount 重置/死亡/复活、Node→sing-box outbound 映射、nodeKey 生成(稳定性+去重)。
- Redis 相关逻辑:`StateStore` 接口 + **真实 redis 集成测**(本地/CI redis,独立 DB index),覆盖 TTL、续期、死亡复活的真实语义。
- probe(经代理 fetch)收口为可注入函数;调度器逻辑(选节点/并发/状态更新)用 mock probe 测;真实经代理检查作为 e2e 冒烟。

## Spec Patch

- 澄清「可用节点」定义:在 `GET /nodes` 与相关 Requirement 中补充「可用 = 至少检查过一次(lastCheck>0)且最近一次成功(failCount===0)」,排除从未检查成功的新节点与 dead 节点。
- 补充订阅刷新 cooldown(防抖)边界场景。
