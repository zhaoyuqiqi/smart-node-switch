# Comet Design Handoff

- Change: add-node-health-monitor
- Phase: design
- Mode: compact
- Context hash: 2ba732969f1978e8b9323a616faa60fbffce0c1b54be7210016b8b0440ea7134

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/add-node-health-monitor/proposal.md

- Source: openspec/changes/add-node-health-monitor/proposal.md
- Lines: 1-33
- SHA256: 6091a767200d961b2147a1ffadd30410a33b2e6ff728e73f6e461ce2cee281ee

```md
## Why

我们有一个订阅节点,里面包含大量代理节点,但无法得知哪些节点当前可用、哪个延迟最低。需要一个服务能持续检测每个节点的真实健康度,并对外暴露「全部可用节点」和「最健康节点」的查询能力,从而把流量导向最优节点。

## What Changes

- 新增一个基于 **Elysia** 的 HTTP 服务,启动后从订阅 URL 拉取并解析代理节点。
- 解析 base64 订阅,支持 **trojan://、vmess://、ss://、vless://** 四种协议 URI,映射为 sing-box outbound。
- 引入 **sing-box**(项目内置二进制 `src/sing-box/sing-box`,v1.13.14)作为代理内核,用于「经代理发真实 HTTP 请求」的健康检查。
- 周期性健康检查(默认 30s,**可配置**),检查**并发执行**(使用 **p-queue**,最大并发数 10),每个节点的状态(延迟、失败次数、最近检查时间、死亡标记)持久化到 **Redis**(通过 **ioredis** 操作)。
- **自动刷新订阅**:当健康节点数(failCount === 0)低于节点总数的 **10%** 时,重新从订阅 URL 拉取最新节点信息,拉取完成后**立即触发一轮检测**。
- **Redis TTL 治理**:节点状态 key 设置过期时间(默认 **2 天**),每次对该节点操作时**续期 2 天**,使长期不再出现的节点自动过期,避免 Redis 存储无限增长。
- 打分系统:`score = latency*0.7 + failCount*100 + (now - lastCheck)*0.001`,**得分越低越健康**;一旦某次检查成功,该节点 failCount 归 0(成功率优先于延迟)。
- 死亡与复活:某节点连续 20 次检查失败 → 标记为 dead,24 小时内不再检查,到期后自动重试(基于 Redis TTL)。
- 提供两个查询 API:
  - `GET /nodes`:返回全部可用节点(最近一次检查成功,即 failCount === 0)及其数量。
  - `GET /nodes/best`:返回得分最低(最健康)的节点。

## Capabilities

### New Capabilities
- `node-health-monitor`: 订阅解析、健康节点过低时自动刷新订阅、并发(p-queue,最大 10)周期性经代理健康检查、基于评分公式的节点打分、带 TTL 治理的 Redis 状态持久化、连续失败死亡判定与 24h 复活,以及对外的可用节点 / 最优节点查询 API。

### Modified Capabilities
<!-- 无既有 spec,纯新增能力 -->

## Impact

- **新增依赖**:`elysia`(HTTP 服务)、`ioredis`(Redis 客户端)、`p-queue`(并发控制)。
- **外部依赖**:运行时需要可访问的 Redis 实例;使用项目内置 sing-box 二进制(darwin/amd64)。
- **新增代码**:订阅拉取/解析、订阅自动刷新触发、sing-box 进程编排与配置生成、并发健康检查调度器、评分与带 TTL 的状态存储、Elysia 路由。
- **配置**:订阅 URL、检查周期、最大并发(默认 10)、健康占比刷新阈值(默认 10%)、节点 key TTL(默认 2 天,每次操作续期 2 天)、Redis 连接、死亡阈值、复活时长、测试 URL 等通过环境变量(.env)提供。
- **运行前提**:服务负责「挑选」最优节点并对外查询,本阶段不负责把用户流量实际转发到选中节点。
```

## openspec/changes/add-node-health-monitor/design.md

- Source: openspec/changes/add-node-health-monitor/design.md
- Lines: 1-50
- SHA256: 347d32449a20946e1023c128be2e0131165e1fe2134cc69349a9e9dddabc14e9

```md
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
- **代理内核:sing-box 子进程**。倾向「单实例多 inbound」:为每个节点分配一个本地 mixed/SOCKS 入站端口,各自路由到对应 outbound,启动一个常驻 sing-box 进程。健康检查 = 通过该节点的本地端口对测试 URL(默认 `http://www.gstatic.com/generate_204`)发请求,测得延迟与可用性。订阅变化时重新生成配置并重启。备选:每次检查临时拉起 sing-box(开销大,弃用)。最终编排细节在深度设计阶段定。
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
```

## openspec/changes/add-node-health-monitor/tasks.md

- Source: openspec/changes/add-node-health-monitor/tasks.md
- Lines: 1-45
- SHA256: 02f6d65dce1c1c37751566700bb3fc98b9167165da44182f04d70e51571eef00

```md
## 1. 项目脚手架与配置

- [ ] 1.1 安装依赖:`bun add elysia ioredis p-queue`,确认 sing-box 二进制可执行
- [ ] 1.2 定义配置加载(.env):订阅 URL、检查周期(默认 30s)、最大并发(默认 10)、健康占比刷新阈值(默认 10%)、节点 key TTL(默认 2 天,每次操作续期 2 天)、Redis 连接、死亡阈值(默认 20)、复活时长(默认 24h)、测试 URL(默认 generate_204)、sing-box 起始端口
- [ ] 1.3 定义统一内部 Node 数据结构与 Redis key 生成规则

## 2. 订阅解析

- [ ] 2.1 实现订阅拉取与 base64 解码
- [ ] 2.2 实现 trojan:// 解析器(含单测)
- [ ] 2.3 实现 vmess:// 解析器(含单测)
- [ ] 2.4 实现 ss:// 解析器(SIP002 / base64 变体,含单测)
- [ ] 2.5 实现 vless:// 解析器(含单测)
- [ ] 2.6 解析聚合:汇总四类节点、跳过非法/不支持条目(含单测)

## 3. sing-box 代理编排

- [ ] 3.1 实现内部 Node → sing-box outbound JSON 映射(四种协议)
- [ ] 3.2 生成 sing-box 配置(每节点一个本地 inbound 端口)并启动/重启常驻进程
- [ ] 3.3 实现「经某节点本地端口请求测试 URL」的探测函数(测延迟与成败,含超时)

## 4. Redis 状态与评分

- [ ] 4.1 实现节点状态读写(latency/failCount/lastCheck/successCount)到 Redis(ioredis),写入设 TTL(默认 2 天)、每次操作续期 2 天(含单测)
- [ ] 4.2 实现评分函数 `latency*0.7 + failCount*100 + (now-lastCheck)*0.001`(含单测)
- [ ] 4.3 实现成功重置 failCount=0 逻辑(含单测)
- [ ] 4.4 实现连续 20 次失败标记 dead + 24h TTL 复活(基于 Redis,含单测)

## 5. 健康检查调度

- [ ] 5.1 实现周期调度器:启动即跑一轮,之后按可配周期循环
- [ ] 5.2 跳过死亡节点;检查后更新 Redis 状态
- [ ] 5.3 用 p-queue 控制最大并发(默认 10)并发执行检查
- [ ] 5.4 实现健康占比监测:可用数 < 总数 10%(可配)时重新拉取订阅并立即触发检测(含单测)

## 6. Elysia API

- [ ] 6.1 搭建 Elysia 服务入口,接入配置与调度器生命周期
- [ ] 6.2 实现 `GET /nodes`:返回 failCount===0 的可用节点及数量
- [ ] 6.3 实现 `GET /nodes/best`:返回得分最低节点;无可用节点时明确响应

## 7. 集成与收尾

- [ ] 7.1 端到端验证:启动 → 解析订阅 → 周期检查 → 两个 API 返回正确
- [ ] 7.2 更新 README:运行方式、环境变量、API 说明
```

## openspec/changes/add-node-health-monitor/specs/node-health-monitor/spec.md

- Source: openspec/changes/add-node-health-monitor/specs/node-health-monitor/spec.md
- Lines: 1-130
- SHA256: 0dc8faeeb79aa823b1ec0ff87dd91ed01ddd7248e0333eb2a1b7f85cbaee9784

[TRUNCATED]

```md
## ADDED Requirements

### Requirement: 订阅拉取与多协议解析
服务 SHALL 在启动时从配置的订阅 URL 拉取内容,对返回的 base64 文本进行解码,并解析其中的代理节点链接。服务 MUST 支持 `trojan://`、`vmess://`、`ss://`、`vless://` 四种协议 URI,并将每个节点映射为统一的内部节点结构。无法识别或解析失败的节点 MUST 被跳过,不得中断其余节点的解析。

#### Scenario: 解析 base64 订阅得到多协议节点
- **WHEN** 订阅 URL 返回 base64 编码的、包含 trojan/vmess/ss/vless 链接的列表
- **THEN** 服务解码并解析出每个受支持协议的节点,生成统一内部结构

#### Scenario: 跳过无法解析的节点
- **WHEN** 订阅中包含一条格式非法或不受支持协议的链接
- **THEN** 服务跳过该条目并继续解析其余节点,不抛出导致流程中断的错误

### Requirement: 经代理的健康检查
服务 SHALL 借助内置 sing-box 二进制,通过被检测节点自身的代理通道,对配置的测试 URL 发起真实 HTTP 请求来检测节点健康度。检查 MUST 测量该请求的延迟(latency,毫秒);请求成功记为一次成功,失败或超时记为一次失败。

#### Scenario: 节点检查成功
- **WHEN** 通过某节点的代理通道请求测试 URL 并收到成功响应
- **THEN** 记录本次延迟为该节点的 latency,并将该节点标记为本轮成功

#### Scenario: 节点检查失败
- **WHEN** 通过某节点的代理通道请求测试 URL 失败或超时
- **THEN** 将该节点标记为本轮失败

### Requirement: 周期性并发检查调度
服务 SHALL 周期性地对每个非死亡节点运行健康检查。检查周期 MUST 可通过配置设置,默认值为 30 秒。同一轮内的检查 MUST 并发执行(基于 p-queue),最大并发数 MUST 可配置,默认值为 10。被标记为死亡的节点在其复活时间到达前 MUST 被跳过。

#### Scenario: 按配置周期循环检查
- **WHEN** 服务运行且检查周期配置为 N 秒
- **THEN** 服务每隔约 N 秒对所有非死亡节点各运行一次健康检查

#### Scenario: 受控并发执行检查
- **WHEN** 一轮检查包含的待检节点数量超过最大并发数
- **THEN** 服务同时进行中的检查数量不超过配置的最大并发数(默认 10),其余排队等待

#### Scenario: 跳过死亡节点
- **WHEN** 某节点处于死亡状态且尚未到达复活时间
- **THEN** 该轮检查跳过该节点

### Requirement: 健康节点过低时自动刷新订阅
服务 SHALL 在可用节点数(lastCheck > 0 且 failCount === 0)低于节点总数的某一占比阈值(默认 10%,且 MUST 可配置)时,重新从订阅 URL 拉取并解析最新节点信息。该判定 MUST 仅在每一轮健康检查完成后进行。刷新完成后,服务 MUST 立即触发一轮健康检查,而不必等待下一个周期。为避免在节点持续不可用时频繁拉取订阅,两次订阅刷新之间 MUST 有最小冷却间隔(可配置,默认 300 秒)。

#### Scenario: 健康占比低于阈值触发刷新
- **WHEN** 一轮检查完成后,可用节点数低于节点总数的配置阈值(默认 10%)且距上次刷新已超过冷却间隔
- **THEN** 服务重新拉取订阅、重建节点集,并立即对最新节点触发一轮健康检查

#### Scenario: 健康占比高于阈值不刷新
- **WHEN** 可用节点数不低于配置阈值
- **THEN** 服务不触发订阅刷新,按既有周期继续检查

#### Scenario: 冷却期内不重复刷新
- **WHEN** 可用占比持续低于阈值,但距上次订阅刷新尚未超过冷却间隔
- **THEN** 服务本轮不再触发订阅刷新,等待冷却结束后再评估

### Requirement: Redis key 过期治理
服务 MUST 为每个节点的状态 key 设置过期时间(默认 2 天),并在每次对该节点状态进行操作时将其过期时间续期 2 天。借此使订阅刷新后不再出现的陈旧节点状态自动过期,避免 Redis 存储无限增长。

#### Scenario: 写入时设置过期
- **WHEN** 某节点的状态首次写入 Redis
- **THEN** 该状态 key 被设置过期时间(默认 2 天)

#### Scenario: 操作时续期
- **WHEN** 某节点的状态被再次读写操作
- **THEN** 该状态 key 的过期时间被续期至 2 天

#### Scenario: 陈旧节点自动过期
- **WHEN** 某节点在续期窗口内不再被任何操作触及
- **THEN** 该节点的状态 key 到期后被 Redis 自动删除

### Requirement: 节点状态持久化到 Redis
服务 SHALL 将每个节点的健康状态(至少包含 latency、failCount、lastCheck)持久化到 Redis,并通过 ioredis 客户端读写。状态 MUST 在每次检查后更新。

#### Scenario: 检查后写入状态
- **WHEN** 某节点完成一次健康检查
- **THEN** 该节点的 latency、failCount、lastCheck 被更新并写入 Redis

### Requirement: 健康评分
服务 SHALL 依据公式 `score = latency * 0.7 + failCount * 100 + (now - lastCheck) * 0.001` 计算每个节点的得分,其中 now 为当前时间戳、lastCheck 为最近一次检查的时间戳。得分越低代表节点越健康。

#### Scenario: 按公式计算得分
```

Full source: openspec/changes/add-node-health-monitor/specs/node-health-monitor/spec.md

