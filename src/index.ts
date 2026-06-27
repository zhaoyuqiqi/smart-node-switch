import { Elysia } from 'elysia';
import { loadConfig } from './config.ts';
import { createRedisStore } from './store/state-store.ts';
import { SingBoxInstance } from './singbox/instance.ts';
import { InstanceOrchestrator } from './singbox/orchestrator.ts';
import { TcpRelay } from './relay.ts';
import { fetchSubscription } from './subscription/fetch.ts';
import { parseSubscription } from './subscription/parse.ts';
import { probe } from './singbox/probe.ts';
import { Monitor } from './monitor.ts';
import { registerRoutes } from './api.ts';
import type { Node } from './types.ts';

async function main() {
  const config = loadConfig();
  const store = createRedisStore(config.redisUrl);

  console.log(`[init] Fetching subscription from ${config.subscriptionUrl}`);
  const nodes = parseSubscription(await fetchSubscription(config.subscriptionUrl));
  console.log(`[init] Parsed ${nodes.length} nodes`);

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
      clashSecret: config.clashApiSecret,
      readyTimeoutMs: config.instanceReadyTimeoutMs,
      exclude,
      portStride: stride,
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
  console.log(`[init] relay listening on ${config.proxyBindAddress}:${config.proxyPort}`);

  // Monitor needs a mutable handle to the active instance's clash + portMap.
  let activeClash = first.clash;
  const monitor = new Monitor({
    store,
    probe,
    refresh: async () =>
      parseSubscription(await fetchSubscription(config.subscriptionUrl)),
    nodes,
    portMap: first.portMap,
    intervalSeconds: config.checkIntervalSeconds,
    maxConcurrency: config.maxConcurrency,
    refreshThreshold: config.refreshThreshold,
    refreshCooldownSeconds: config.refreshCooldownSeconds,
    nodeTtlSeconds: config.nodeTtlSeconds,
    deathThreshold: config.deathThreshold,
    revivalSeconds: config.revivalSeconds,
    testUrl: config.testUrl,
    probeTimeoutMs: config.probeTimeoutMs,
    clash: { setSelector: (t) => activeClash.setSelector(t) },
  });

  const orchestrator = new InstanceOrchestrator({
    relay,
    initial: first,
    createInstance,
    maxDrainSeconds: config.maxDrainSeconds,
    onActiveChange: (inst) => {
      // CV1: re-point monitor's portMap + clash at the new active instance,
      // otherwise monitor goes blind ("no port for") to the new nodes.
      activeClash = (inst as SingBoxInstance).clash;
      monitor.updateNodes(monitor.getNodes(), (inst as SingBoxInstance).portMap);
    },
  });
  // Wire orchestrator into monitor after construction.
  monitor.setOrchestrator(orchestrator);

  const app = new Elysia();
  registerRoutes(app, monitor, store, {
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
