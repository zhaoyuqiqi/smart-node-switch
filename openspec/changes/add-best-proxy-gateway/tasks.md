## 1. 配置与类型

- [x] 1.1 config 新增:PROXY_PORT、proxyBindAddress、Clash API 端口/secret、sing-box 蓝绿两套实例端口段、relay 排空策略/超时(含单测)
- [x] 1.2 类型扩展:`Node` 增加 `originalUri`;`NodeView` 增加 `raw` 与 `originalUri`

## 2. Req1 节点信息补全

- [x] 2.1 解析器在 `Node` 上保存 `originalUri`(四协议,含单测)
- [x] 2.2 `api.ts` 的 `/nodes` 与 `/nodes/best` 返回补全 raw + originalUri(含单测)

## 3. Req2 端口跳过

- [x] 3.1 实现端口可用性探测(尝试绑定 127.0.0.1:port,占用则跳过)（含单测）
- [ ] 3.2 `buildConfig` 端口分配改为按可用性分配,跳过占用端口、记录实际 portMap;支持避开排除端口集(蓝绿用)（含单测）
- [ ] 3.3 sing-box 启动失败(端口竞争)时回退重试下一段端口

## 4. Req3 转发代理(selector + Clash API)

- [ ] 4.1 `buildConfig` 增加固定 proxy 入站(mixed,bind 可配)+ selector 出站(成员=全部节点 outbound,`interrupt_exist_connections: false`)+ route 规则 + 启用 clash_api(含单测)
- [ ] 4.2 实现 Clash API 客户端:把 selector 切到指定 outbound(含单测,可对 mock HTTP)
- [ ] 4.3 monitor 在 best 变化时调用 Clash API 热切 selector(不重启)（含单测,mock clash 客户端）

## 5. Req3-HA TCP relay + 蓝绿双实例

- [ ] 5.1 实现常驻 Bun TCP relay:监听对外 PROXY_PORT,透明转发到当前活跃上游端口,支持原子切换上游;切换时保留已建立连接、仅新连接走新上游(含单测,可用本地 echo TCP 服务)
- [ ] 5.2 实现 sing-box 实例"就绪"探测(端口可连 / Clash API ready)
- [ ] 5.3 蓝绿编排:节点集更新时起新实例→就绪→切 relay 上游→优雅排空(保留旧连接,达最大排空超时才硬关)→关闭旧实例(含单测,mock 实例与 relay)
- [ ] 5.4 monitor 的订阅刷新接入蓝绿编排,替换原 restart 路径

## 6. /proxy API 与装配

- [ ] 6.1 实现 `GET /proxy`:返回固定代理地址 + 当前 best 完整信息;无可用节点时明确响应(含单测)
- [ ] 6.2 `index.ts` 接入 relay、蓝绿编排、Clash API 客户端的生命周期

## 7. 集成与收尾

- [ ] 7.1 端到端验证:起服务 → /nodes 含完整信息 → 占用部分端口仍启动 → Python 经固定代理出网 → 触发刷新代理不中断
- [ ] 7.2 更新 README:新增配置项、/proxy 用法、Python 代理示例、Docker 两端口暴露说明
