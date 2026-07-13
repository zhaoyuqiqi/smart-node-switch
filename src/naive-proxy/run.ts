import { spawn } from "node:child_process";

export async function run(binPath: string, args: string[]) {
  const child = spawn(binPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  const code = await new Promise<number>((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => resolvePromise(exitCode ?? 0));
  });

  return {
    code,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}
