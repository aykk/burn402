import { spawn } from "node:child_process";
import { join } from "node:path";

export type AgentRun<T> = { pid: number | null; ok: boolean; result?: T; error?: string };

export function runStressTester<T>(root: string, input: Record<string, unknown>, timeoutMs = 180_000): Promise<AgentRun<T>> {
  return runAgentProgram<T>(root, "stresstester.ts", input, timeoutMs);
}

export function runAgentProgram<T>(root: string, file: string, input: Record<string, unknown>, timeoutMs = 180_000): Promise<AgentRun<T>> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", join("agents", file)], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      clearTimeout(timer);
      const last = out.trim().split("\n").at(-1) ?? "";
      try {
        const parsed = JSON.parse(last) as { ok: boolean; pid: number; result?: T; error?: string };
        resolve({ pid: parsed.pid, ok: parsed.ok, result: parsed.result, error: parsed.error });
      } catch {
        resolve({ pid: child.pid ?? null, ok: false, error: (err || out || "no output").slice(-500) });
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
