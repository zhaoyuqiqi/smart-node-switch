## Context

当前实现通过应用层 `monitor + probe + scoring` 维护节点状态，并使用 Clash API 手动切换 selector。这套方案与 sing-box 原生 `urltest` 职责重叠，导致：
- 配置复杂（每节点独立探测路径与端口）
- 代码面广（探测、评分、切换、持久化耦合）
- 运行开销增加（应用层探测 + 控制面 IPC）

本次重构目标是把“最优节点选择”下沉到 sing-box 内核，应用层仅保留“订阅刷新决策 + 蓝绿实例编排 + 对外固定代理入口”。项目尚未上线，允许 breaking change。

## Goals / Non-Goals

**Goals:**
- 使用 sing-box `urltest` 出站自动测速并选择最优节点。
- 删除应用层自研评分与主动切换链路。
- 保留并继续强化蓝绿切换与连接不中断能力。
- 缩减端口占用和配置复杂度。

**Non-Goals:**
- 不新增代理协议。
- 不做向后兼容层。
- 不改部署模型（Bun + sing-box + Docker）。

## Decisions

- **决策 1：由 sing-box `urltest` 接管选优**
  - 方案：配置 `urltest` outbound（成员为所有节点 outbound），代理入口路由到该 outbound。
  - 原因：内核层探测与切换效率更高，减少应用层逻辑。
  - 备选方案：继续保留应用层评分，只把部分指标交给 sing-box；被否决，因复杂度仍高。

- **决策 2：移除 per-node 探测入口与评分模块**
  - 方案：删除/瘦身 `probe`、`scoring`、`monitor` 的选优职责，不再维护“每节点探测端口”。
  - 原因：避免重复实现、降低维护成本。
  - 备选方案：保留模块但停用；被否决，因易产生死代码和误导。

- **决策 3：保留蓝绿双实例 + 常驻 relay**
  - 方案：订阅刷新仍通过编排器启动新实例并原子切换 relay 上游，旧实例优雅排空。
  - 原因：这是项目核心价值（更新不中断），与 urltest 不冲突。
  - 备选方案：直接重启单实例；被否决，因会带来可感知中断窗口。

- **决策 4：刷新触发由“应用层可用性观察”驱动，而非评分驱动**
  - 方案：通过已有状态（如 Clash API 的节点可用性信息）判断是否触发订阅刷新。
  - 原因：去掉评分后仍需保留自动刷新能力。
  - 备选方案：改为固定周期强制刷新；被否决，因无效刷新较多。

## Risks / Trade-offs

- [urltest 参数不当可能导致切换抖动] → 通过 `tolerance`、`interval` 和连接不中断策略控制。
- [移除旧模块导致测试大面积失效] → 同步重写关键测试，优先覆盖启动、选优、刷新、蓝绿切换。
- [无可用节点时行为变化] → 显式定义 `/proxy` 与 relay 行为，避免隐式失败。
- [breaking change 影响开发习惯] → 在 README 和设计文档中给出迁移说明。

## Migration Plan

1. 调整 `singbox/config`：引入 `urltest`，移除 per-node 探测入口依赖。
2. 重构 `monitor`：删除评分与切换职责，仅保留刷新判定与编排触发。
3. 清理 `scoring/probe` 及其引用，更新 `index` 装配。
4. 修复并重写相关测试（单元 + 关键集成）。
5. 更新 README 与 OpenSpec 文档，完成行为说明。

回滚策略：若重构阶段出现阻塞，可回退到本变更前 commit；本次不引入双栈兼容路径。

## Open Questions

- 刷新判定优先读取哪个来源（Clash API 统计 vs 本地轻量状态）？
- 无可用节点时是否统一返回 `503`（含 reason）？
- `urltest` 默认参数（interval/tolerance/idle_timeout）采用何值最稳妥？