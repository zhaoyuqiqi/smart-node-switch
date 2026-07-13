import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import { connect } from "node:net";
import { proxyListenAddress, proxyTestAddress, urls } from "./config";

interface Config {
  listen?: string;
  proxy: string;
}
async function getProxy() {
  for (const url of urls) {
    const res = await fetch(url);
    if (res.ok) {
      const config = (await res.json()) as Config;
      const isAvailable = await setProxyAndTest(config);
      if (isAvailable) {
        return true;
      }
    }
  }
  return false;
}

async function setProxyAndTest(config: Config) {
  let binPath = "src/naive-proxy/bin/naive-linux";
  if (process.platform === "darwin") {
    binPath = "src/naive-proxy/bin/naive-mac";
  }
  await chmod(binPath, 0o755);
  const child = spawn(binPath, [
    `--listen=${proxyListenAddress}`,
    `--proxy=${config.proxy}`,
  ]);
  const isReady = await waitForProxyReady(proxyTestAddress);
  if (!isReady) {
    child.kill();
    return false;
  }
  const isAvailable = await testAvailable();
  console.log(isAvailable, [
    `--listen=${proxyListenAddress}`,
    `--proxy=${config.proxy}`,
  ]);
  if (!isAvailable) {
    child.kill();
    return false;
  }
  return true;
}

async function waitForProxyReady(address: string, timeoutMs = 5000) {
  const { hostname, port } = new URL(address);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await canConnect(hostname, Number(port))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function canConnect(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function testAvailable() {
  try {
    const res = await fetch("https://www.google.com", {
      proxy: proxyTestAddress,
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (await testAvailable()) {
    return;
  }
  let isAvailable = await setProxyAndTest({
    proxy: process.env.NAIVE_PROXY!,
  });
  if (!isAvailable) {
    isAvailable = await getProxy();
  }
  if (!isAvailable) {
    console.log("naive proxy is unavaiable");
    return;
  }
  console.log("naive proxy is avaiable");
}

export function naiveProxyStart() {
  main();
  setInterval(main, 30_000);
}
