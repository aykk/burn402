import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importJWK, type JWK } from "jose";
import { VultrResource } from "../lib/burn";
import { bootScript } from "../lib/demo/servers";
import { mandateHash, signMandate, toCompact, type Mandate, type SigningKey } from "../lib/mandate";
import { payingFetch, requestProvision, signProvisionRequest } from "../lib/x402";

type Input =
  | { command: "rent"; brokerUrl: string; chain: string[]; plan: string; region: string }
  | { command: "rent-direct"; plan: string; region: string; mandateJti: string; budget: string }
  | { command: "forge"; brokerUrl: string; root: string; ops: string; plan: string; region: string };

const ROOT = process.cwd();

function env(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const file = join(ROOT, ".env.local");
  const value = existsSync(file) ? new RegExp(`^${name}=(.+)$`, "m").exec(readFileSync(file, "utf8"))?.[1]?.trim() : undefined;
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function identity(): Promise<SigningKey & { name: string }> {
  const f = JSON.parse(readFileSync(join(ROOT, ".burn402", "keys", "stresstester.json"), "utf8")) as { ansName: string; kid: string; privateJwk: JWK };
  return { name: f.ansName, kid: f.kid, privateKey: (await importJWK(f.privateJwk, "EdDSA")) as CryptoKey };
}

async function readInput(): Promise<Input> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Input;
}

async function main(): Promise<unknown> {
  const input = await readInput();
  const me = await identity();

  if (input.command === "rent") {
    const leaf = input.chain[input.chain.length - 1];
    return requestProvision({
      url: input.brokerUrl,
      chain: input.chain,
      mandate: mandateHash(leaf),
      subject: me.name,
      subjectKey: me,
      plan: input.plan,
      region: input.region,
      fetch: await payingFetch(env("AGENT_SOLANA_SECRET_KEY")),
    });
  }

  if (input.command === "rent-direct") {
    const vultr = new VultrResource({ apiKey: env("VULTR_API_KEY") });
    const hourlyUsd = await vultr.quote({ plan: input.plan, region: input.region });
    const handle = await vultr.provision({
      plan: input.plan,
      region: input.region,
      label: "burn402-stresstester-direct",
      userData: bootScript({ rentedBy: me.name, how: "directly from Vultr, skipping the broker", budget: input.budget, plan: input.plan }),
    });
    return { handle, hourlyUsd, mandateJti: input.mandateJti };
  }

  if (input.command === "forge") {
    const now = Math.floor(Date.now() / 1000);
    const forged: Mandate = {
      jti: `m_forged_${now}`,
      iss: input.ops,
      sub: me.name,
      aud: me.name,
      parent: mandateHash(input.root),
      depth: 1,
      max_depth: 3,
      scope: ["compute:provision"],
      limit_usd: 20,
      rate_usd_hr: 1,
      nbf: now - 60,
      exp: now + 3600,
    };
    const compact = toCompact(await signMandate(forged, me));
    const request = await signProvisionRequest({ iss: me.name, mandate: mandateHash(compact), plan: input.plan, region: input.region }, me);
    const response = await fetch(input.brokerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chain: [input.root, compact], request }),
    });
    return { status: response.status, body: await response.json() };
  }

  throw new Error("unknown command");
}

main().then(
  (result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, pid: process.pid, result })}\n`);
    process.exit(0);
  },
  (error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, pid: process.pid, error: (error as Error).message })}\n`);
    process.exit(1);
  },
);
