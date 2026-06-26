import { Elysia } from 'elysia';
import { loadConfig } from './config.ts';
import { createRedisStore } from './store/state-store.ts';
import { SingBoxProcess } from './singbox/process.ts';
import { fetchSubscription } from './subscription/fetch.ts';
import { parseSubscription } from './subscription/parse.ts';
import { probe } from './singbox/probe.ts';
import { Monitor } from './monitor.ts';
import { registerRoutes } from './api.ts';

async function main() {
  const config = loadConfig();

  // Redis store
  const store = createRedisStore(config.redisUrl);

  // Fetch initial subscription
  console.log(`[init] Fetching subscription from ${config.subscriptionUrl}`);
  const lines = await fetchSubscription(config.subscriptionUrl);
  const nodes = parseSubscription(lines);
  console.log(`[init] Parsed ${nodes.length} nodes`);

  // Start sing-box
  const singbox = new SingBoxProcess(config.singboxBin, config.singboxBasePort);
  const portMap = await singbox.start(nodes);
  console.log(`[init] sing-box started with ${portMap.size} ports`);

  // Refresh function for monitor
  const refresh = async () => {
    const newLines = await fetchSubscription(config.subscriptionUrl);
    const newNodes = parseSubscription(newLines);
    const newPortMap = await singbox.restart(newNodes);
    monitor.updateNodes(newNodes, newPortMap);
    return newNodes;
  };

  // Monitor
  const monitor = new Monitor({
    store,
    probe,
    refresh,
    nodes,
    portMap,
    intervalSeconds: config.checkIntervalSeconds,
    maxConcurrency: config.maxConcurrency,
    refreshThreshold: config.refreshThreshold,
    refreshCooldownSeconds: config.refreshCooldownSeconds,
    nodeTtlSeconds: config.nodeTtlSeconds,
    deathThreshold: config.deathThreshold,
    revivalSeconds: config.revivalSeconds,
    testUrl: config.testUrl,
    probeTimeoutMs: config.probeTimeoutMs,
  });

  // Elysia app
  const app = new Elysia();
  registerRoutes(app, monitor, store);

  // Lifecycle: start monitor on app start, stop on shutdown
  app.onStart(async () => {
    console.log('[monitor] Starting health check scheduler...');
    void monitor.start();
  });

  app.onStop(async () => {
    console.log('[monitor] Stopping...');
    monitor.stop();
    await singbox.stop();
  });

  app.listen(3000);
  console.log(`[api] Listening on http://localhost:3000`);
}

main().catch((err: unknown) => {
  console.error('[fatal]', err);
  process.exit(1);
});
