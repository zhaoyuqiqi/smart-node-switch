# Brainstorm Summary

- Change: add-best-proxy-gateway
- Date: 2026-06-27

## 确认的技术方案

- **Req1 信息补全**:`Node` 增 `originalUri`(解析时保存);`NodeView` 增 `raw` + `originalUri`;api 从内存 Node 取,无需 Redis 存 raw。
- **Req2 端口跳过**:端口分配改为按可用性分配(尝试绑定 127.0.0.1:port 探测,占用则跳),portMap 记实际端口;支持排除端口集(蓝绿避让);启动失败回退下一段端口兜底(TOCTOU)。
- **Req3 代理(A1)**:单 sing-box 实例含:N 个 per-node 检查入站(in-<key>→out-<key>)+ 1 个固定 proxy 入站(in-proxy→selector)+ selector 出站(成员=全部 out-<key>,`interrupt_exist_connections:false`)+ block 出站 + `experimental.clash_api`(127.0.0.1 + secret)。monitor 在 best 变化时调 Clash API `PUT /proxies/<selector>` 切到 best 的 out-<key>,不重启。
- **Req3-HA relay+蓝绿**:对外代理口由常驻 Bun TCP relay 持有(0.0.0.0:PROXY_PORT)。relay 持 `activeUpstreamPort`,新连接读当前值并透明 pipe,切换=更新变量,旧 pipe 不动。节点集变化→build 新实例(端口段错开)→就绪探测(TCP 连 proxy 入站口/clash ready)→relay 切上游→优雅排空旧实例(保留旧连接,达 300s 最大排空超时才硬关)→关旧实例。best 切换只走 Clash API,不触发蓝绿。
- **切换不中断已建立连接**:selector `interrupt_exist_connections:false`(best 切换不断旧连接)+ relay 优雅排空(蓝绿不断旧连接),max drain 300s 兜底。
- **无可用节点**:selector 指向 block 出站,代理连接立即拒绝;`GET /proxy` 返回「无可用代理」。
- **/proxy**:返回 `{proxy:"http://<host>:<PROXY_PORT>", node:<best 完整 NodeView>}`。
- **实例模型**:单全功能实例整体蓝绿(简单);代价=切换瞬间 ~2N 检查入站端口并存(transient)。备选=拆 checker/proxy 两实例(省端口但多进程),本期取单实例。
- **配置**:PROXY_PORT、proxyBindAddress、CLASH_API 端口/secret、两套实例端口段(stride)、MAX_DRAIN_SECONDS=300、就绪探测超时等。

## 关键取舍与风险

- 单实例蓝绿:简单,但切换瞬间 ~2N 检查入站端口并存(transient,刷新不频繁,可接受)。
- 长连接钉在起始节点/实例:稳定性优先于时效;>300s 超长连接蓝绿时会被截断。
- 端口 TOCTOU:探测+启动失败重试兜底。
- 代理端口无鉴权对外:部署/网络层负责;Clash API 仅 127.0.0.1+secret。
- relay 透明 TCP:mixed 入站对客户端是标准代理协议,TCP 层透明即可。

## 测试策略

- 纯逻辑单测:NodeView 补全(raw+originalUri)、端口探测/分配(跳过占用、排除集)、toOutbound 含 selector/block/proxy 入站配置生成、Clash API 客户端(对 mock HTTP)。
- relay 单测:本地 echo TCP 上游,验证透明转发、切换上游后新连接走新上游且旧连接保留。
- 蓝绿编排单测:mock 实例(起/就绪/关)与 relay,验证就绪后才切、优雅排空、超时硬关。
- monitor:mock Clash 客户端,验证 best 变化触发切换、无可用→block、节点集变化触发蓝绿。
- StateStore 真实 redis 集成测沿用既有。
- e2e 冒烟:真实 sing-box + Python 经固定代理出网 + 触发刷新代理不中断(网络相关,非阻塞)。

## Spec Patch

待定:若 brainstorming 发现 delta spec 缺验收场景再补。当前候选:无(open 阶段已含「切换不中断已建立连接」「无可用节点」等场景)。
