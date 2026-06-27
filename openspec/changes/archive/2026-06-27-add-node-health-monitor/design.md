## Context

项目为全新 Bun 工程,仅有空 `src/index.ts` 和内置 sing-box 二进制(`src/sing-box/sing-box`,v1.13.14)。需要从一个订阅 URL 拉取大量代理节点,持续检测健康度并对外提供查询。约束:运行时 Bun;HTTP 框架用 Elysia(用户指定);Redis 用 ioredis(用户指定);真实可用性必须「经代理」检测,代理能力由 sing-box 提供。

本文件给出高层架构与关键技术选型;line-by-line 实现与 TDD 计划在 `/comet-design`(深度设计)阶段产出。

## Goals / Non-Goals

**Goals:**
- 启动时拉取并解析 base64 订阅,支持 trojan / vmess / ss / vless 四种协议。
- 借助 sing-box「经代理」对每个节点发真实 HTTP 请求,测量延迟与成功/失败。
- 周期检查(默认 30s,可配),检查并发执行(p-queue,最大并发 10),将节点状态(latency / failCount / lastCheck / dead)持久化到 Redis。
- 健康节点数 < 总数 10% 时自动重新拉取订阅,拉取后立即触发一轮检测。
- 节点状态 key 带 TTL(默认 2 天),每次操作续期 2 天,使陈旧节点自动过期。
- 按公式 `latency*0.7 + failCount*100 + (now-lastCheck)*0.001` 打分,越低越健康;成功即把 failCount 归 0。
- 连续 20 次失败标记 dead,24h 内跳过,到期自动复活。
- `GET /nodes`(全部 failCount===0 节点 + count)与 `GET /nodes/best`(最低分节点)。

**Non-Goals:**
- 不把用户流量实际转发/代理到选中节点(只做检测与挑选)。
- 不做订阅管理 UI、鉴权、多订阅源。
- 不实现协议握手本身(交给 sing-box)。

## Decisions

- **HTTP 框架:Elysia**(用户指定)。运行于 Bun,原生 TS,路由声明式。替代 CLAUDE.md 默认的 `Bun.serve()` —— 用户显式要求优先。
- **Redis 客户端:ioredis**(用户指定),替代 `Bun.redis`。
- **代理内核:sing-box 子进程**。倾向「单实例多 inbound」:为每个节点分配一个本地 mixed/SOCKS 入站端口,各自路由到对应 outbound,启动一个常驻 sing-box 进程。健康检查 = 通过该节点的本地端口对测试 URL(默认 `https://www.google.com`)发请求,测得延迟与可用性。订阅变化时重新生成配置并重启。备选:每次检查临时拉起 sing-box(开销大,弃用)。最终编排细节在深度设计阶段定。
- **协议解析:四个独立 parser**(trojan/vmess/ss/vless URI → 统一内部 Node 结构 → sing-box outbound JSON)。vmess 通常为 base64(JSON),ss 为 `ss://base64@host:port` 或 SIP002,trojan/vless 为 URL 形式。
- **节点状态存 Redis**:每个节点一个 key(由稳定标识派生,如 `protocol:server:port` 哈希),存 latency/failCount/lastCheck/successCount 等;dead 状态用带 24h TTL 的 key 表示,TTL 到期即自动复活。
- **Redis TTL 治理**:节点状态 key 写入时设过期(默认 2 天),每次对该节点操作(读/写)时续期 2 天。这样持续被检测的节点保持存活,而订阅刷新后不再出现的旧节点会自然过期,避免 Redis 无限膨胀。注意与 dead key 的 24h TTL 相互独立。
- **并发检查:p-queue**。一轮检查把所有待检节点入队,`concurrency` 默认 10(可配),避免大量节点同时经 sing-box 检查打满 CPU/端口/网络。
- **订阅自动刷新**:每轮检查后(或查询时)评估 `健康数 / 总数`,低于阈值(默认 10%)即重新拉取订阅、重建节点集与 sing-box 配置,并立即触发一轮检测。阈值可配。
- **配置走环境变量(.env)**:订阅 URL、检查周期、最大并发(默认 10)、健康占比刷新阈值(默认 10%)、节点 key TTL(默认 2 天,每次操作续期 2 天)、Redis 连接、死亡阈值(默认 20)、复活时长(默认 24h)、测试 URL、sing-box 起始端口等。Bun 自动加载 .env。
- **调度**:启动后立即跑一轮,之后按周期循环;dead 节点跳过;检查经 p-queue 并发执行。

## Risks / Trade-offs

- [sing-box 多 inbound 端口占用大/启动慢] → 端口范围可配;订阅节点过多时可分批或复用,深度设计阶段评估。
- [二进制为 darwin/amd64,跨平台部署受限] → 当前在本机(darwin)运行可用;生产部署需匹配架构的二进制,记为运行前提。
- [订阅协议字段多样、解析易出错] → 每种协议写解析单测,覆盖常见变体;无法解析的节点跳过并记录。
- [`(now-lastCheck)` 在节点从未检查时偏大] → 初始化 lastCheck 策略在深度设计阶段定义,避免新节点被过度惩罚。
- [Redis 不可用导致状态丢失] → 状态本就周期重建;Redis 故障时服务降级,深度设计阶段定义降级行为。

## Open Questions

- sing-box 进程编排最终形态(单实例多端口 vs 分批),以及订阅刷新时的重启策略。
- 节点唯一标识键的精确生成规则(含同 server:port 不同参数的去重)。
- 新节点 lastCheck / failCount 初始值,避免首次评分失真。
- 订阅刷新阈值的判定时机(每轮检查后 vs 定时 vs 查询触发)与防抖,避免在节点持续不可用时频繁刷新订阅。
