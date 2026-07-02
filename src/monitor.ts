import type { Node, NodeStatistics } from './types.ts';
import { calculateNodeScore, computeNodeStatistics } from './node-statistics.ts';
import type { NodeMetricsStore } from './node-metrics-store.ts';
import type { GetNodeLatenciesOptions } from './singbox/clash.ts';
import dayjs from 'dayjs';

export type RefreshFn = () => Promise<Node[]>;

export interface MonitorOptions {
  refresh: RefreshFn;
  nodes: Node[];
  intervalSeconds: number;
  refreshThreshold: number;
  refreshCooldownSeconds: number;
  clash: {
    setSelector(outboundTag: string): Promise<void>;
    getNodeLatencies?(options?: GetNodeLatenciesOptions): Promise<Record<string, number | null>>;
  };
  probeUrl?: string;
  probeTimeoutMs?: number;
  activeProbeIntervalSeconds?: number;
  metricsStore?: NodeMetricsStore;
  orchestrator?: { blueGreenSwap(newNodes: Node[]): Promise<boolean> };
  onBestChange?: (bestKey: string | null) => void;
  debug?: boolean;
}

interface CandidateNode {
  key: string;
  score: number;
  rtt: number | null;
}

export class Monitor {
  private nodes: Node[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private bestSyncTimer: ReturnType<typeof setInterval> | null = null;
  private lastRefreshAt = Date.now() / 1000;
  private stopped = false;
  private isRunning = false;
  private bestKey: string | null = null;
  private latencyByKey = new Map<string, number | null>();
  private historyByKey = new Map<string, number[]>();
  private statisticsByKey = new Map<string, NodeStatistics>();
  private scoreByKey = new Map<string, number>();
  private storeHydrated = false;
  private lastLatencySnapshotSignature: string | null = null;
  private lastActiveProbeAtMs = 0;

  /**
   * 创建监控器实例，并以当前订阅节点集作为初始状态。
   *
   * @param opts 监控器运行参数：包括节点来源、刷新阈值、测速读取与 selector 切换能力。
   * @remarks 这里只做状态初始化，不会启动定时任务；真正启动在 {@link start} 中完成。
   */
  constructor(private opts: MonitorOptions) {
    this.nodes = opts.nodes;
  }

  /**
   * 输出调试日志。
   *
   * @param args 任意调试上下文参数，会原样转发到 `console.log`。
   * @remarks 仅在 `opts.debug` 为 `true` 时输出，用于排查评分、切换与刷新过程。
   */
  private debug(...args: unknown[]): void {
    if (!this.opts.debug) return;
    ``
    console.log(`\x1b[32m${dayjs().format('YYYY-MM-DD HH:mm:ss')}\x1b[0m [monitor:debug]`, ...args);
  }

  /**
   * 按“当前订阅节点”裁剪所有内存缓存，避免历史节点长期滞留。
   *
   * @remarks
   * - 会清理 `latency/history/statistics/score` 四个 Map 中不再存在于订阅内的 key。
   * - 该方法只做内存收敛，不触发外部 I/O 与回调。
   */
  private pruneCachesToCurrentNodes(): void {
    const activeKeys = new Set(this.nodes.map((n) => n.key));

    const prune = <T>(map: Map<string, T>): void => {
      for (const key of map.keys()) {
        if (!activeKeys.has(key)) {
          map.delete(key);
        }
      }
    };

    prune(this.latencyByKey);
    prune(this.historyByKey);
    prune(this.statisticsByKey);
    prune(this.scoreByKey);
  }

  /**
   * 更新当前订阅节点集合，并立即执行缓存裁剪。
   *
   * @param nodes 新的节点列表（通常来源于订阅刷新或蓝绿切换成功后的结果）。
   * @remarks 该操作不会立即触发评分计算；评分在下一轮 {@link runRound} 中完成。
   */
  updateNodes(nodes: Node[]) {
    this.nodes = nodes;
    this.pruneCachesToCurrentNodes();
  }

  /**
   * 注入（或替换）实例编排器，用于订阅变更后的蓝绿切换。
   *
   * @param o 提供 `blueGreenSwap` 能力的编排器。
   */
  setOrchestrator(o: { blueGreenSwap(newNodes: Node[]): Promise<boolean> }) {
    this.opts.orchestrator = o;
  }

  /**
   * 启动监控主循环。
   *
   * @remarks
   * 启动步骤：
   * 1. 先从 Redis（若启用）回填历史样本，减少冷启动抖动；
   * 2. 执行首轮检测；
   * 3. 若暂未选出 best，进行最多 15 次 warm-up 重试（1 秒间隔）；
   * 4. 启动主定时器（`intervalSeconds`）；
   * 5. 在主周期大于 5 秒时，再启动快速同步定时器（每 5 秒，跳过订阅刷新判断）。
   */
  async start() {
    await this.hydrateHistoryFromStore();
    await this.runRound();

    // Warm-up: urltest history may need a few seconds before first RTT appears.
    if (!this.bestKey) {
      const maxAttempts = 15;
      for (let i = 0; i < maxAttempts && !this.bestKey && !this.stopped; i++) {
        await Bun.sleep(1000);
        await this.runRound(true);
      }
    }

    this.timer = setInterval(() => {
      void this.runRound();
    }, this.opts.intervalSeconds * 1000);

    const bestSyncMs = Math.min(5000, this.opts.intervalSeconds * 1000);
    if (bestSyncMs < this.opts.intervalSeconds * 1000) {
      this.bestSyncTimer = setInterval(() => {
        void this.runRound(true);
      }, bestSyncMs);
    }
  }

  /**
   * 停止监控器并清理所有定时器。
   *
   * @remarks 该方法是幂等的，多次调用不会产生额外副作用。
   */
  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.bestSyncTimer) {
      clearInterval(this.bestSyncTimer);
      this.bestSyncTimer = null;
    }
  }

  /**
   * 从持久化存储中回填每个节点最近样本（最多 100 条），仅执行一次。
   *
   * @returns Promise<void>
   * @remarks
   * - 若未配置 `metricsStore`，会直接返回；
   * - 回填失败按节点降级处理（打印警告，不中断整体启动）；
   * - 通过 `storeHydrated` 防止重复回填。
   */
  private async hydrateHistoryFromStore(): Promise<void> {
    if (this.storeHydrated) return;
    this.storeHydrated = true;

    const store = this.opts.metricsStore;
    if (!store) return;

    await Promise.all(this.nodes.map(async (node) => {
      try {
        const samples = await store.readRecentSamples(node.key);
        if (samples.length > 0) {
          this.historyByKey.set(node.key, samples.slice(-100));
        }
      } catch (error) {
        console.warn('[monitor] metricsStore.readRecentSamples failed', {
          key: node.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }));
  }

  /**
   * 执行一轮监控：同步评分/最优节点，并按需触发订阅刷新。
   *
   * @param skipRefreshCheck `true` 时跳过刷新判断，仅做评分同步（用于快速同步与 warm-up）。
   * @returns Promise<void>
   * @remarks
   * - 内置互斥（`isRunning`），避免并发重入；
   * - 仅当检测到“新 RTT 样本快照”时，才会进入刷新判断。
   */
  async runRound(skipRefreshCheck = false): Promise<void> {
    if (this.stopped || this.isRunning) return;
    this.isRunning = true;
    try {
      this.pruneCachesToCurrentNodes();
      const synced = await this.syncStatisticsAndBestByScore();
      if (synced && !skipRefreshCheck) {
        await this.maybeRefresh();
      }
    } catch (e) {
      console.error('[monitor] runRound failed', e);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 构建当前 RTT 快照签名，用于判断是否出现新样本。
   *
   * @param latencies 当前轮次读取到的节点 RTT 映射。
   * @returns 稳定字符串签名（按当前节点顺序拼接 `key:latency`）。
   * @remarks
   * 当签名与上次一致时，表示本轮没有新数据，会跳过样本写入/Redis/选路等重操作。
   */
  private buildLatencySnapshotSignature(latencies: Record<string, number | null>): string {
    return this.nodes
      .map((node) => {
        const latency = latencies[node.key] ?? null;
        return `${node.key}:${latency ?? 'null'}`;
      })
      .join('|');
  }

  /**
   * 基于配置与上次探测时间，判断本轮是否应触发主动 delay 探测。
   *
   * @returns `true` 表示本轮应主动探测；`false` 表示仅读取当前快照。
   * @remarks
   * - 间隔来源：`activeProbeIntervalSeconds`，未配置时回退到 `intervalSeconds`。
   * - 间隔最小为 1 秒，避免错误配置导致 0 或负值。
   * - 首轮总是会主动探测（`lastActiveProbeAtMs=0`）。
   */
  private shouldActiveProbeNow(): boolean {
    const intervalSeconds = Math.max(1, this.opts.activeProbeIntervalSeconds ?? this.opts.intervalSeconds);
    const intervalMs = intervalSeconds * 1000;
    return Date.now() - this.lastActiveProbeAtMs >= intervalMs;
  }

  /**
   * 同步统计信息、评分与 best 选择。
   *
   * @returns
   * - `true`：检测到新 RTT 快照并完成本轮同步；
   * - `false`：快照未变化，已跳过本轮同步逻辑。
   *
   * @remarks
   * 主要流程：
   * 1. 根据主动探测节流策略决定是否触发 delay 探测；
   * 2. 读取 Clash 延迟快照；
   * 3. 签名去重（同快照直接跳过）；
   * 4. 维护每节点历史样本（超时写为 `-1`，最多 100 条）；
   * 5. 计算统计值和分数，并写入内存；
   * 6. 持久化到 Redis（若启用）；
   * 7. 选出本轮最优节点；
   * 8. 仅当 best 发生变化时调用 `setSelector` 并触发 `onBestChange`。
   */
  private async syncStatisticsAndBestByScore(): Promise<boolean> {
    const activeProbe = this.shouldActiveProbeNow();
    const latencyOptions: GetNodeLatenciesOptions = {
      activeProbe,
      probeUrl: this.opts.probeUrl,
      probeTimeoutMs: this.opts.probeTimeoutMs,
    };

    const latencies = this.opts.clash.getNodeLatencies
      ? await this.opts.clash.getNodeLatencies(latencyOptions)
      : {};

    if (activeProbe) {
      this.lastActiveProbeAtMs = Date.now();
    }

    const signature = this.buildLatencySnapshotSignature(latencies);
    if (signature === this.lastLatencySnapshotSignature) {
      this.debug('latency snapshot unchanged, skip score/redis/selector sync');
      return false;
    }
    this.debug('latency snapshot changed');
    this.lastLatencySnapshotSignature = signature;

    this.latencyByKey = new Map();

    const candidates: CandidateNode[] = [];
    const roundSyncAt = new Date().toISOString();

    for (const node of this.nodes) {
      const latency = latencies[node.key] ?? null;
      this.latencyByKey.set(node.key, latency);

      const sample = latency ?? -1;
      const prev = this.historyByKey.get(node.key) ?? [];
      const nextSamples = [...prev, sample];
      if (nextSamples.length > 100) {
        nextSamples.splice(0, nextSamples.length - 100);
      }
      this.historyByKey.set(node.key, nextSamples);

      const stats = {
        ...computeNodeStatistics(nextSamples),
        lastSyncAt: roundSyncAt,
      };
      const score = calculateNodeScore(stats, nextSamples);

      this.statisticsByKey.set(node.key, stats);
      this.scoreByKey.set(node.key, score);

      try {
        await this.opts.metricsStore?.record(node.key, sample, stats, score);
      } catch (error) {
        console.warn('[monitor] metricsStore.record failed', {
          key: node.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      candidates.push({ key: node.key, score, rtt: latency });
    }

    const nextBest = this.pickBest(candidates);

    this.debug('score snapshot', {
      totalNodes: this.nodes.length,
      best: nextBest,
      top5: candidates
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5),
    });

    if (nextBest !== this.bestKey) {
      this.debug('best changed', { from: this.bestKey, to: nextBest });

      if (nextBest) {
        try {
          await this.opts.clash.setSelector(`out-${nextBest}`);
        } catch (error) {
          console.error('[monitor] setSelector failed', {
            key: nextBest,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.bestKey = nextBest;
      this.opts.onBestChange?.(this.bestKey);
    }

    return true;
  }

  /**
   * 从候选列表中按规则挑选 best 节点。
   *
   * @param candidates 候选节点列表（已包含 score 与本轮 RTT）。
   * @returns 最终 best 的节点 key；若无可用候选则返回 `null`。
   * @remarks
   * 排序规则：
   * 1. 只保留 `score > 0` 的节点；
   * 2. 分数降序；
   * 3. 分数相同按 RTT 升序（`null` 视为无穷大）；
   * 4. 再按 key 字典序稳定排序。
   */
  private pickBest(candidates: CandidateNode[]): string | null {
    const ranked = candidates.filter((c) => c.score > 0);
    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aRtt = a.rtt ?? Number.POSITIVE_INFINITY;
      const bRtt = b.rtt ?? Number.POSITIVE_INFINITY;
      if (aRtt !== bRtt) return aRtt - bRtt;
      return a.key.localeCompare(b.key);
    });
    return ranked[0]?.key ?? null;
  }

  /**
   * 按可用性与健康度规则判断是否需要刷新订阅，并在需要时执行节点切换。
   *
   * @returns Promise<void>
   * @remarks
   * 触发条件（满足任一）：
   * - 可用比例低于阈值（当前实现中 best 是否存在映射为 0/1）；
   * - 得分 >= 60 的节点占比低于 10%。
   *
   * 刷新后逻辑：
   * - 若节点集合变化且存在 orchestrator，则走蓝绿切换；
   * - 否则直接更新节点集合；
   * - 最后立即再做一次评分同步。
   */
  private async maybeRefresh(): Promise<void> {
    const { refresh, refreshThreshold, refreshCooldownSeconds } = this.opts;
    const total = this.nodes.length;
    if (total === 0) return;

    const nowSec = Date.now() / 1000;
    if (nowSec - this.lastRefreshAt < refreshCooldownSeconds) return;

    const availableRatio = this.bestKey ? 1 : 0;
    const healthyCount = this.nodes.filter((n) => (this.scoreByKey.get(n.key) ?? 0) >= 60).length;
    const healthyRatio = healthyCount / total;

    // Rule: if score >=60 nodes are lower than 10% of all nodes, trigger subscription refresh.
    const shouldRefreshByScore = healthyRatio < 0.1;
    const shouldRefreshByAvailability = availableRatio < refreshThreshold;

    if (!shouldRefreshByAvailability && !shouldRefreshByScore) return;

    this.lastRefreshAt = nowSec;
    const newNodes = await refresh();
    const changed = !this.sameNodeSet(this.nodes, newNodes);
    if (changed && this.opts.orchestrator) {
      const ok = await this.opts.orchestrator.blueGreenSwap(newNodes);
      if (ok) {
        this.updateNodes(newNodes);
      } else {
        console.error('[monitor] blueGreenSwap failed; keeping old instance');
      }
    } else {
      this.updateNodes(newNodes);
    }
    await this.syncStatisticsAndBestByScore();
  }

  /**
   * 比较两组节点是否由同一批 key 组成（忽略顺序）。
   *
   * @param a 节点集合 A。
   * @param b 节点集合 B。
   * @returns `true` 表示 key 集合一致；否则返回 `false`。
   */
  private sameNodeSet(a: Node[], b: Node[]): boolean {
    if (a.length !== b.length) return false;
    const sa = new Set(a.map((n) => n.key));
    for (const n of b) if (!sa.has(n.key)) return false;
    return true;
  }

  /**
   * 获取当前订阅节点列表（内存态）。
   *
   * @returns 当前生效的节点数组。
   */
  getNodes(): Node[] {
    return this.nodes;
  }

  /**
   * 获取当前 best 节点对象。
   *
   * @returns best 节点；若尚未选出或节点已不存在则返回 `null`。
   */
  getBestNode(): Node | null {
    if (!this.bestKey) return null;
    return this.nodes.find((n) => n.key === this.bestKey) ?? null;
  }

  /**
   * 获取当前 best 节点 key。
   *
   * @returns best 的 key；若无可用 best 则为 `null`。
   */
  getBestKey(): string | null {
    return this.bestKey;
  }

  /**
   * 获取指定节点最近一次 RTT（内存态）。
   *
   * @param key 节点 key。
   * @returns RTT 毫秒值；无数据或超时无快照时返回 `null`。
   */
  getLatency(key: string): number | null {
    return this.latencyByKey.get(key) ?? null;
  }

  /**
   * 获取指定节点的统计信息（内存态）。
   *
   * @param key 节点 key。
   * @returns 节点统计信息；若节点尚未参与计算则返回 `null`。
   */
  getStatistics(key: string): NodeStatistics | null {
    return this.statisticsByKey.get(key) ?? null;
  }

  /**
   * 获取指定节点当前分数（内存态）。
   *
   * @param key 节点 key。
   * @returns 节点评分；若无分数记录返回 `0`。
   */
  getScore(key: string): number {
    return this.scoreByKey.get(key) ?? 0;
  }
}
