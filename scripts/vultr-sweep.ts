import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VultrResource } from "../lib/burn";

function apiKey(): string {
  if (process.env.VULTR_API_KEY) return process.env.VULTR_API_KEY;
  const file = join(process.cwd(), ".env.local");
  const key = existsSync(file) ? /^VULTR_API_KEY=(.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim() : undefined;
  if (!key) throw new Error("VULTR_API_KEY is not set and .env.local has none");
  return key;
}

async function main() {
  const vultr = new VultrResource({ apiKey: apiKey() });
  const running = await vultr.listTagged();
  if (running.length === 0) {
    process.stdout.write("no burn402 instances running\n");
    return;
  }
  for (const i of running) process.stdout.write(`destroying ${i.id} ${i.ip} (${i.status}/${i.power})\n`);
  const destroyed = await vultr.sweep();
  process.stdout.write(`destroyed ${destroyed.length}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
