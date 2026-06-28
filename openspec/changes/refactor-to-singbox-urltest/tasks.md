## 1. sing-box 配置重构（urltest 接管选优）

- [x] 1.1 在 `src/singbox/config.ts` 引入 `urltest` outbound，候选集覆盖节点 outbounds
- [x] 1.2 调整代理入口路由到 `urltest`，移除依赖应用层手动 selector 切换的配置
- [x] 1.3 清理 per-node 探测入站端口相关配置与映射依赖

## 2. 应用层职责瘦身

- [x] 2.1 重构 `src/monitor.ts`：删除评分/手动切换职责，仅保留刷新判定与编排触发
- [x] 2.2 移除 `src/scoring.ts` 与 `src/singbox/probe.ts` 的核心运行时依赖（必要时删除文件）
- [x] 2.3 更新 `src/index.ts` 装配链路，确保与新 monitor/sing-box 配置一致

## 3. 测试重建与回归

- [x] 3.1 更新受影响单元测试（config、monitor、orchestrator 相关）
- [x] 3.2 删除或改写基于旧评分模型的测试用例
- [x] 3.3 运行 `bun run --bun tsc --noEmit` 与项目测试，修复失败项

## 4. 文档与对外说明

- [x] 4.1 更新 `README.md`：说明 `urltest` 自动选优行为与关键参数
- [x] 4.2 更新设计/计划文档中“自研评分选优”表述为“原生 urltest 选优”
- [x] 4.3 补充 breaking change 说明（不保证向后兼容）