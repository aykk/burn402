import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importJWK, type JWK } from "jose";
import { runLlm, type ToolDef, type ToolRunner, type Turn } from "../lib/demo/llm";
import { mandateHash, signJws, type SigningKey } from "../lib/mandate";
import { A2A_TYP, companySystemPrompt, companyTask, type Brief, type Counter, type Offer, type QuoteRequest } from "../lib/train";
import { payingFetch, requestProvision } from "../lib/x402";

type Input = {
  runId: string;
  keyFile?: string;
  brokerBase: string;
  chain: string[];
  brief: Brief;
  provider: string;
  model: string;
  modelName: string;
  company: string;
  apiKey: string;
  baseUrl: string | null;
};

const ROOT = process.cwd();
const VULTR_AGENT = process.env.BURN402_VULTR_AGENT ?? "ans://v1.0.0.vultr.burn402.xyz";

function env(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const file = join(ROOT, ".env.local");
  const value = existsSync(file) ? new RegExp(`^${name}=(.+)$`, "m").exec(readFileSync(file, "utf8"))?.[1]?.trim() : undefined;
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function identity(keyFile: string): Promise<SigningKey & { name: string }> {
  const f = JSON.parse(readFileSync(join(ROOT, ".burn402", "keys", `${keyFile}.json`), "utf8")) as { ansName: string; kid: string; privateJwk: JWK };
  return { name: f.ansName, kid: f.kid, privateKey: (await importJWK(f.privateJwk, "EdDSA")) as CryptoKey };
}

async function readInput(): Promise<Input> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Input;
}

const tools: ToolDef[] = [
  {
    name: "ask_vultr",
    description:
      "Send a signed A2A message to the Vultr desk agent. Use kind 'quote_request' first to get the plan list with real prices and measured timings for this job. Use kind 'counter' once to push back, with max_minutes or max_usd if you want a hard limit.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["quote_request", "counter"], description: "quote_request first, then counter at most once" },
        message: { type: "string", description: "What you are asking the desk, in one or two sentences" },
        max_minutes: { type: "number", description: "Optional: only quote plans that have the model ready within this many minutes" },
        max_usd: { type: "number", description: "Optional: only quote plans where this job costs at most this many USDC" },
      },
      required: ["kind", "message"],
    },
  },
  {
    name: "rent_server",
    description:
      "Ask the broker to rent one server on the given plan and start the training job on it. Your mandate and signature go with the request, and the x402 payment is made from your wallet when the broker asks for it.",
    parameters: { type: "object", properties: { plan: { type: "string", description: "A plan id the Vultr desk quoted" } }, required: ["plan"] },
  },
];

async function main() {
  const input = await readInput();
  const me = await identity(input.keyFile ?? "ops");
  let rented: { lease?: { handle?: string; plan?: string } } | null = null;
  let plan: string | null = null;
  let asks = 0;
  let rentals = 0;
  let quoted: string[] = [];

  const run: ToolRunner = async (name, args) => {
    if (name === "ask_vultr") {
      if (asks >= 3) return JSON.stringify({ error: "you have asked the desk enough; pick one of the plans it quoted and rent it" });
      const at = Math.floor(Date.now() / 1000);
      const message: QuoteRequest | Counter =
        args.kind === "counter"
          ? {
              conv: input.runId,
              kind: "counter",
              iss: me.name,
              aud: VULTR_AGENT,
              at,
              ask: String(args.message),
              maxSeconds: typeof args.max_minutes === "number" ? Math.round(args.max_minutes * 60) : null,
              maxUsd: typeof args.max_usd === "number" ? args.max_usd : null,
            }
          : { conv: input.runId, kind: "quote_request", iss: me.name, aud: VULTR_AGENT, at, brief: input.brief, note: String(args.message) };
      const signed = await signJws(message, me, A2A_TYP);
      const response = await fetch(`${input.brokerBase}/api/agents/vultr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });
      const body = (await response.json()) as { offer?: Offer; error?: string };
      if (!response.ok || !body.offer) return JSON.stringify({ error: body.error ?? `the desk answered HTTP ${response.status}` });
      asks++;
      quoted = body.offer.quotes.map((q) => q.plan);
      return JSON.stringify({
        from: "vultr desk",
        says: body.offer.text,
        recommends: body.offer.recommend,
        plans: body.offer.quotes.map((q) => ({
          plan: q.plan,
          vcpus: q.vcpus,
          ram_gb: q.ramGb,
          cores: q.familyLabel,
          usd_per_hour: q.hourlyUsd,
          ready_in_minutes: Math.round(q.totalSeconds / 6) / 10,
          job_costs_usd: q.jobUsd,
          budget_lasts_hours: q.budgetHours,
          enough_ram: q.enoughRam,
          within_your_hourly_limit: q.withinRate,
        })),
      });
    }
    if (name === "rent_server") {
      if (rentals >= 1) return JSON.stringify({ error: "you already rented a server for this job" });
      if (quoted.length === 0) return JSON.stringify({ error: "ask the Vultr desk for a quote before you rent anything" });
      if (!quoted.includes(String(args.plan))) {
        return JSON.stringify({ error: `${String(args.plan)} is not a plan the desk quoted; pick one of ${quoted.join(", ")}` });
      }
      rentals++;
      const leaf = input.chain[input.chain.length - 1];
      const result = await requestProvision({
        url: `${input.brokerBase}/api/provision`,
        chain: input.chain,
        mandate: mandateHash(leaf),
        subject: me.name,
        subjectKey: me,
        plan: String(args.plan),
        region: input.brief.region,
        fetch: await payingFetch(env("AGENT_SOLANA_SECRET_KEY")),
      });
      if (result.status === 200) {
        rented = result.body as { lease?: { handle?: string; plan?: string } };
        plan = rented.lease?.plan ?? String(args.plan);
      } else {
        rentals = 0;
      }
      return JSON.stringify({ status: result.status, body: result.body });
    }
    return JSON.stringify({ error: `unknown tool ${name}` });
  };

  const transcript: Turn[] = await runLlm({
    provider: input.provider,
    model: input.model,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    system: companySystemPrompt(me.name, input.brief.budgetUsd, input.brief.rateUsdHr),
    task: companyTask(input.brief),
    tools,
    run,
    maxTurns: 8,
  });

  return { model: input.modelName, provider: input.company, transcript, rented, plan };
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
