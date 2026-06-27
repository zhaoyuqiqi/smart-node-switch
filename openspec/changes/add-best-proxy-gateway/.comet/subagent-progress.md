# Subagent Progress — add-best-proxy-gateway

- build_mode: subagent-driven-development
- review_mode: thorough (批次≤3 task 合并审查 + 最终完整审查;每批次/最终最多 2 轮审查-修复)
- tdd_mode: tdd
- branch: feature/20260627/add-best-proxy-gateway
- merge-base: c5a0ad09ffd5dab269a6fa2945269d353f5bf814
- plan: docs/superpowers/plans/2026-06-27-best-proxy-gateway.md
- 共 12 个 plan task;批次划分:[1-3] [4-6] [7-9] [10-12] + final

## 当前

- 当前阶段: subagent 派发循环完成 → 返回 comet-build 退出条件
- final review: round1 CHANGES-REQUESTED(C1 CRITICAL + I1 IMPORTANT)→ 修复 b4f7d55 → round2 RE-REVIEW APPROVED(C1/I1 resolved,无新问题,116 pass,tsc 0)
- 已接受/跟进的非 CRITICAL(记录理由):
  - I1 已设 1MiB pending 缓冲上限;established 管道背压未做 → 已在代码注释 + README 标注为已知限制
  - M4(无可用→block 语义)自动化未覆盖 setSelector('block') 是否被 sing-box 接受 → 需用户在真实环境手动 e2e 验证「无可用节点→代理连接被拒」
  - M1(1500ms 固定等待)/M2(legacy process.ts)/M3(temp config 不清理)/I2(waitReady 末轮 sleep)→ 合并后跟进,均不阻塞
  - 7.1 live e2e 为手动非阻塞步骤(design §8);自动化 116 pass 为门禁,live e2e 文档化于 README
- tsc 全绿,114 pass
- Task 10 7b40782(/proxy) / Task 11 8ebc72a(index 装配+CV1/CV3) / Task 12 f109d86(README)
- 已知风险:曾出现 1 次偶发 timing flake(后 5/5 绿);交 final review 评估是否加固 timing 测试
- final review 残留 MINOR triage:relay 背压(MINOR2)、clash.waitReady 末轮 sleep 越界(MINOR4)、instance configPath 同 basePort 并发碰撞/1500ms 固定窗口(batch79 MINOR1/3)

### Task 11 接线必做清单(batch[7-9] Cannot-Verify,强约束)
- (CV1) 蓝绿 swap 成功后,monitor 的 portMap+clash 必须经 onActiveInstance 更新为新实例,否则蓝绿后 monitor 对新节点失明(no port for)。orchestrator.onActiveChange → monitor 更新 portMap/clash。
- (CV3) monitor.maybeRefresh 在 blueGreenSwap 返回 false 时仍把 this.nodes=newNodes,与运行中旧实例不一致;Task 11 复核:swap 失败应回退 this.nodes 到旧集合。
- (MINOR4 batch79) monitor.currentBestKey 死字段(真正去重是 lastSelector):删除或在接线时使用。
- 注:implementer 因权限无法 commit/部分无法跑测试,协调者负责验证(tsc+bun test)后提交
- 携带给 Task 4 的约束(batch[1-3] reviewer MINOR#1):sing-box inbounds 保持 listen 127.0.0.1,以匹配 isPortFree(127.0.0.1) 探测;对外 0.0.0.0 由 relay(Task 6) 负责

## 已完成 task

- Task 1（config+types）:1bd5c68 ✓ batch[1-3] APPROVED;openspec 1.1/1.2 ✓
- Task 2（parser originalUri + API）:4a4eee9(+tsc fix) ✓;openspec 2.1/2.2 ✓
- Task 3（ports.ts 探测+分配）:9b7ddd6 ✓;openspec 3.1 ✓(3.2 归 Task4,3.3 归 Task7)

## 批次审查状态

- batch [1-3]: APPROVED (spec ✅ / quality approved, 仅 MINOR;0 轮修复)
- batch [4-6]: APPROVED (spec ✅ / quality approved, 仅 MINOR;0 轮修复)
- batch [7-9]: APPROVED (spec ✅ / quality approved, 仅 MINOR;0 轮修复)
- final review: APPROVED (round1 CHANGES-REQUESTED C1+I1 → fix b4f7d55 → round2 APPROVED)
- batch [10-12]: pending
- final: pending

## Minor findings 累计(交 final review triage)

batch[4-6]:
- MINOR1 (relay.ts): connectUpstream pending 时 client 先关 → upstream socket 孤儿泄漏。**指派 Task 8 修复**(蓝绿排空依赖计数正确):open 回调里若 pair 已不在 conns 则立即 up.end()。
- MINOR2 (relay.ts): 无背压/drain 处理,大流量可能内存堆积。指派 Task 8 评估(接真实流量前)。
- MINOR3 (relay.ts:124): teardown `_origin` 死参数,可删。final triage。
- MINOR4 (clash.ts waitReady): 末轮 sleep 可能略越 timeout。建议 sleep(min(100, deadline-now))。final triage 或 Task 7 顺手。
