import { Elysia } from 'elysia';
import { loadConfig } from './config.ts';
import { SingBoxInstance } from './singbox/instance.ts';
import { InstanceOrchestrator } from './singbox/orchestrator.ts';
import { TcpRelay } from './relay.ts';
import { fetchSubscription } from './subscription/fetch.ts';
import { parseSubscription } from './subscription/parse.ts';
import { Monitor } from './monitor.ts';
import { registerRoutes } from './api.ts';
import type { Node } from './types.ts';

async function main() {
  const config = loadConfig();

  console.log(`[init] Fetching subscription from ${config.subscriptionUrl}`);
  const nodes = parseSubscription(await fetchSubscription(config.subscriptionUrl));
  console.log(`[init] Parsed ${nodes.length} nodes`);
  console.log(`[init] config: SINGBOX_BIN=${config.singboxBin} TEST_URL=${config.testUrl} DEBUG_MONITOR=${config.debugMonitor}`);

  // Instance factory: blue/green alternate base ports via stride.
  let instanceGen = 0;
  const createInstance = (instNodes: Node[], exclude: Set<number>): SingBoxInstance => {
    const gen = instanceGen++;
    const stride = config.singboxInstancePortStride;
    return new SingBoxInstance({
      binPath: config.singboxBin,
      nodes: instNodes,
      basePort: config.singboxBasePort + (gen % 2) * stride,
      proxyInboundOffset: config.singboxProxyInboundOffset,
      clashPort: config.clashApiBasePort + (gen % 2),
      clashBindAddress: config.clashApiBindAddress,
      clashSecret: config.clashApiSecret,
      readyTimeoutMs: config.instanceReadyTimeoutMs,
      exclude,
      portStride: stride,
      testUrl: config.testUrl,
      proxyAuthUser: config.proxyAuthUser,
      proxyAuthPass: config.proxyAuthPass,
    });
  };

  // First instance.
  const first = createInstance(nodes, new Set());
  await first.start();
  if (!(await first.ready())) {
    throw new Error('[init] first sing-box instance failed readiness');
  }
  console.log(`[init] sing-box ready: in-proxy=${first.proxyInboundPort} clash=${first.clashPort}`);

  // Always-on relay pointing at the first instance's in-proxy port.
  const relay = new TcpRelay({
    bindAddress: config.proxyBindAddress,
    port: config.proxyPort,
    initialUpstreamPort: first.proxyInboundPort,
  });
  relay.start();
  // 默认不接入新连接，待 monitor 首次同步出 best 后再打开。
  relay.setAccepting(false);
  console.log(`[init] relay listening on ${config.proxyBindAddress}:${config.proxyPort}`);

  let activeClash = first.clash;
  const monitor = new Monitor({
    refresh: async () =>
      parseSubscription(await fetchSubscription(config.subscriptionUrl)),
    nodes,
    intervalSeconds: config.checkIntervalSeconds,
    refreshThreshold: config.refreshThreshold,
    refreshCooldownSeconds: config.refreshCooldownSeconds,
    clash: {
      getCurrentOutbound: (tag) => activeClash.getCurrentOutbound(tag),
      getNodeLatencies: () => activeClash.getNodeLatencies(),
    },
    onBestChange: (bestKey) => {
      relay.setAccepting(Boolean(bestKey));
    },
    debug: config.debugMonitor,
  });

  const orchestrator = new InstanceOrchestrator({
    relay,
    initial: first,
    createInstance,
    maxDrainSeconds: config.maxDrainSeconds,
    onActiveChange: (inst) => {
      activeClash = (inst as SingBoxInstance).clash;
    },
  });
  monitor.setOrchestrator(orchestrator);

  const app = new Elysia();
  registerRoutes(app, monitor, {
    publicHost: config.proxyPublicHost,
    port: config.proxyPort,
  });

  app.onStart(async () => {
    console.log('[monitor] Starting health check scheduler...');
    void monitor.start();
  });
  app.onStop(async () => {
    console.log('[monitor] Stopping...');
    monitor.stop();
    relay.stop();
    await orchestrator.active.stop();
  });

  process.on('SIGINT', () => {
    console.log('[shutdown] received SIGINT, cleaning up...');
    void app.stop();
  });
  process.on('SIGTERM', () => {
    console.log('[shutdown] received SIGTERM, cleaning up...');
    void app.stop();
  });

  app.listen(3000);
  console.log(`[api] Listening on http://localhost:3000`);
}

main().catch((err: unknown) => {
  console.error('[fatal]', err);
  process.exit(1);
});
