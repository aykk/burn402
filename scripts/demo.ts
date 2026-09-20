import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HttpTlSource, parseRootKeys, TransparencyLogDirectory, type DirectoryEntry } from "../lib/ans";
import { VultrResource } from "../lib/burn";

const ROOT = process.cwd();
const ANS = resolve(process.env.ANS_REPO ?? "ans");
const TI_BIN = join(ROOT, "agent-trust-discovery", "bin", "agent-trust-discovery");
const STATE = join(ROOT, ".burn402");
const PINNED = join(ROOT, "config", "ans", "tl-root-keys.txt");
const RA = process.env.RA_URL ?? "http://localhost:18080";
const TL = process.env.TL_URL ?? "http://localhost:18081";
const TI = process.env.TRUST_INDEX_URL ?? "http://localhost:8090";
const TL_KEY = process.env.TL_API_KEY ?? "tl-internal-key";
const children: ChildProcess[] = [];

const log = (line: string) => process.stdout.write(`[demo] ${line}\n`);

async function healthy(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function waitFor(url: string, name: string, seconds = 60): Promise<void> {
  for (let i = 0; i < seconds * 4; i++) {
    if (await healthy(url)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${name} did not become healthy at ${url}`);
}

async function ansStack(): Promise<void> {
  if ((await healthy(`${RA}/v2/admin/ready`)) && (await healthy(`${TL}/v2/admin/ready`))) {
    log("ANS stack already running");
    return;
  }
  if (!existsSync(join(ANS, "scripts", "demo", "start.sh"))) throw new Error(`ANS reference repo not found at ${ANS}`);
  log("starting ANS stack with --keep (existing data and keys are reused)");
  execFileSync(join(ANS, "scripts", "demo", "start.sh"), ["--keep"], { cwd: ANS, stdio: ["ignore", "ignore", "inherit"] });
  await waitFor(`${TL}/v2/admin/ready`, "transparency log");
  log("ANS stack ready on :18080 (RA), :18081 (TL), :18082 (finder)");
}

async function pinTlKeys(): Promise<void> {
  const live = await (await fetch(`${TL}/root-keys`, { headers: { Authorization: `Bearer ${TL_KEY}` } })).text();
  const liveKeys = parseRootKeys(live);
  const pinnedText = existsSync(PINNED) ? readFileSync(PINNED, "utf8") : "";
  const pinned = parseRootKeys(pinnedText);
  const missing = live
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && liveKeys.has(l.split("+")[1]) && !pinned.has(l.split("+")[1]));
  if (missing.length > 0) {
    writeFileSync(PINNED, `${pinnedText.trim()}\n${missing.join("\n")}\n`.replace(/^\n/, ""));
    log(`pinned new TL key ${missing.map((l) => l.split("+")[1]).join(", ")} (older keys kept so earlier records still verify)`);
  }
}

async function agents(): Promise<void> {
  const file = join(STATE, "directory.json");
  if (existsSync(file)) {
    const entries = JSON.parse(readFileSync(file, "utf8")) as Record<string, DirectoryEntry>;
    const directory = new TransparencyLogDirectory({
      source: new HttpTlSource(TL, TL_KEY),
      rootKeys: parseRootKeys(readFileSync(PINNED, "utf8")),
      entries,
    });
    const names = Object.keys(entries);
    const ok = await Promise.all(names.map((n) => directory.isAnchored(n)));
    if (ok.every(Boolean)) {
      log(`agents registered and anchored: ${names.map((n) => n.replace(/^ans:\/\/v[\d.]+\./, "")).join(", ")}`);
      return;
    }
    log("agent state does not match the running transparency log; re-registering");
  }
  execFileSync("npx", ["tsx", join("scripts", "register-agents.ts")], { cwd: ROOT, stdio: "inherit" });
}

async function trustIndex(): Promise<void> {
  if (await healthy(`${TI}/health`)) {
    log("Trust Index already running");
    return;
  }
  if (!existsSync(TI_BIN)) throw new Error(`Trust Index binary missing; run: (cd agent-trust-discovery && make demo)`);
  rmSync("/tmp/burn402-trust-index.db", { force: true });
  const child = spawn(TI_BIN, ["-config", join("config", "trust-index", "runtime.yaml")], { cwd: ROOT, stdio: "ignore" });
  children.push(child);
  await waitFor(`${TI}/health`, "Trust Index");
  log("Trust Index ready on :8090 (fresh database, behavior starts at 0)");
}

function next(): ChildProcess {
  const child = spawn("npx", ["next", "dev"], { cwd: ROOT, stdio: "inherit" });
  children.push(child);
  return child;
}

function shutdown(stopAns: boolean): void {
  for (const c of children) c.kill("SIGTERM");
  if (stopAns && existsSync(join(ANS, "scripts", "demo", "stop.sh"))) {
    try {
      execFileSync(join(ANS, "scripts", "demo", "stop.sh"), [], { cwd: ANS, stdio: "ignore" });
      log("ANS stack stopped (data kept)");
    } catch {}
  }
}

async function sweepServers(): Promise<void> {
  const file = join(ROOT, ".env.local");
  const key = process.env.VULTR_API_KEY ?? (existsSync(file) ? /^VULTR_API_KEY=(.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim() : undefined);
  if (!key) return;
  const destroyed = await new VultrResource({ apiKey: key }).sweep();
  if (destroyed.length > 0) log(`destroyed ${destroyed.length} leftover burn402 server(s) on Vultr`);
}

async function main() {
  const stopAns = process.argv.includes("--stop-ans");
  await sweepServers();
  await ansStack();
  await pinTlKeys();
  await agents();
  await trustIndex();
  const stop = () => {
    shutdown(stopAns);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (await healthy("http://localhost:3000/api/demo/state")) {
    log("app already running on http://localhost:3000; ctrl+c stops what this launcher started");
    setInterval(() => {}, 1 << 30);
    return;
  }
  log("starting the app on http://localhost:3000");
  const app = next();
  app.on("exit", (code) => {
    shutdown(stopAns);
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  process.stderr.write(`[demo] ${(error as Error).message}\n`);
  shutdown(false);
  process.exit(1);
});
