import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VultrResource } from "../lib/burn";
import { detect, jobSpec, trainingBootScript, type TrainingStatus } from "../lib/train";

const REGION = process.env.BURN402_REGION ?? "ewr";
const PLANS = (process.env.CALIBRATE_PLANS ?? "vc2-1c-1gb,vhf-1c-1gb,vhp-1c-1gb-amd").split(",");
const DATASET_URL = process.env.CALIBRATE_DATASET ?? "https://raw.githubusercontent.com/justmarkham/pycon-2016-tutorial/master/data/sms.tsv";

function apiKey(): string {
  if (process.env.VULTR_API_KEY) return process.env.VULTR_API_KEY;
  const file = join(process.cwd(), ".env.local");
  const key = /^VULTR_API_KEY=(.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim();
  if (!key) throw new Error("VULTR_API_KEY is not set");
  return key;
}

async function poll(ip: string): Promise<TrainingStatus | null> {
  return fetch(`http://${ip}/status.json`, { signal: AbortSignal.timeout(4000) })
    .then((r) => (r.ok ? (r.json() as Promise<TrainingStatus>) : null))
    .catch(() => null);
}

async function measure(resource: VultrResource, plan: string, dataset: Awaited<ReturnType<typeof probe>>): Promise<void> {
  const spec = jobSpec("calibration", dataset);
  const handle = await resource.provision({
    plan,
    region: REGION,
    label: `burn402-calibrate-${plan}`,
    userData: trainingBootScript({ spec, rentedBy: "calibration", budget: "calibration run", plan }),
  });
  const started = Date.now();
  process.stdout.write(`${plan.padEnd(22)} ${handle} provisioned\n`);
  try {
    let live = 0;
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const state = await resource.state(handle);
      if (!state.ip || state.ip === "0.0.0.0") continue;
      const status = await poll(state.ip);
      if (!status) continue;
      if (live === 0) {
        live = Date.now();
        process.stdout.write(`${plan.padEnd(22)} answered after ${Math.round((live - started) / 1000)}s of boot\n`);
      }
      if (status.error) throw new Error(status.error);
      if (status.done) {
        process.stdout.write(
          `${plan.padEnd(22)} trained in ${status.elapsed}s on ${status.vcpus} vCPU, ${status.configs_total} fold jobs, boot ${Math.round((live - started) / 1000)}s\n`,
        );
        return;
      }
    }
    throw new Error("timed out");
  } finally {
    await resource.destroy(handle);
    process.stdout.write(`${plan.padEnd(22)} destroyed\n`);
  }
}

async function probe() {
  const head = await fetch(DATASET_URL, { headers: { Range: "bytes=0-200000" } });
  const text = await head.text();
  const total = head.headers.get("content-range")?.split("/")[1] ?? head.headers.get("content-length");
  return detect(text, { name: DATASET_URL.split("/").pop() ?? "dataset", bytes: Number(total) || text.length, origin: "url", url: DATASET_URL }).dataset;
}

async function main() {
  const resource = new VultrResource({ apiKey: apiKey() });
  const dataset = await probe();
  await Promise.all(
    PLANS.map(async (plan) => {
      try {
        await measure(resource, plan, dataset);
      } catch (error) {
        process.stdout.write(`${plan.padEnd(22)} failed: ${(error as Error).message}\n`);
      }
    }),
  );
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
