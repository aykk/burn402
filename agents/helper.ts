import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { importJWK, type JWK } from "jose";
import { mandateHash, type SigningKey } from "../lib/mandate";
import { payingFetch, requestProvision } from "../lib/x402";

type Input = {
  brokerBase: string;
  chain: string[];
  region: string;
  budgetUsd: number;
  rateUsdHr: number;
  need: string;
  provider: string;
  model: string;
  modelName: string;
  company: string;
  apiKey: string;
  baseUrl: string | null;
};

export type Turn = { kind: "task" | "text" | "tool_call" | "tool_result"; content: string };

const ROOT = process.cwd();

function env(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const file = join(ROOT, ".env.local");
  const value = existsSync(file) ? new RegExp(`^${name}=(.+)$`, "m").exec(readFileSync(file, "utf8"))?.[1]?.trim() : undefined;
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function identity(): Promise<SigningKey & { name: string }> {
  const f = JSON.parse(readFileSync(join(ROOT, ".burn402", "keys", "helper.json"), "utf8")) as { ansName: string; kid: string; privateJwk: JWK };
  return { name: f.ansName, kid: f.kid, privateKey: (await importJWK(f.privateJwk, "EdDSA")) as CryptoKey };
}

async function readInput(): Promise<Input> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Input;
}

type ToolDef = { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required: string[] } };

const tools: ToolDef[] = [
  {
    name: "read_agent_card",
    description: "Fetch the broker's A2A agent card, which describes its skills, endpoints and how it takes payment.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_plans",
    description: "List the server plans the broker can rent, with vCPUs, RAM, GPU and hourly price in USD.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "rent_server",
    description:
      "Ask the broker to rent one server of the given plan. Your budget chain and signature are attached automatically, and the x402 payment is made from your wallet if the broker asks for it. Returns the broker's answer.",
    parameters: {
      type: "object",
      properties: { plan: { type: "string", description: "Plan id from list_plans, for example vc2-1c-1gb" } },
      required: ["plan"],
    },
  },
];

type Tools = (name: string, args: Record<string, unknown>) => Promise<string>;

async function callTool(transcript: Turn[], run: Tools, name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  transcript.push({ kind: "tool_call", content: `${name}(${Object.keys(args).length ? JSON.stringify(args) : ""})` });
  let content: string;
  let isError = false;
  try {
    content = await run(name, args);
  } catch (error) {
    content = (error as Error).message;
    isError = true;
  }
  transcript.push({ kind: "tool_result", content: content.length > 600 ? `${content.slice(0, 600)}…` : content });
  return { content, isError };
}

async function anthropicLoop(input: Input, system: string, task: string, transcript: Turn[], run: Tools): Promise<void> {
  const client = new Anthropic({ apiKey: input.apiKey });
  const defs: Anthropic.Tool[] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  for (let turn = 0; turn < 8; turn++) {
    const response = await client.messages.create({ model: input.model, max_tokens: 16000, system, tools: defs, messages });
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) transcript.push({ kind: "text", content: block.text.trim() });
    }
    if (response.stop_reason === "refusal") {
      transcript.push({ kind: "text", content: "(the model declined this request)" });
      return;
    }
    if (response.stop_reason !== "tool_use") return;
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const { content, isError } = await callTool(transcript, run, block.name, (block.input ?? {}) as Record<string, unknown>);
      results.push({ type: "tool_result", tool_use_id: block.id, content, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

async function openAiLoop(input: Input, system: string, task: string, transcript: Turn[], run: Tools): Promise<void> {
  const defs = tools.map((t) => ({ type: "function", function: t }));
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: task },
  ];
  for (let turn = 0; turn < 8; turn++) {
    const res = await fetch(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({ model: input.model, messages, tools: defs }),
    });
    type Reply = { choices?: { message: Extract<ChatMessage, { role: "assistant" }> }[]; error?: { message?: string } };
    const raw = (await res.json().catch(() => ({}))) as Reply | Reply[];
    const body = Array.isArray(raw) ? (raw[0] ?? {}) : raw;
    if (!res.ok || !body.choices?.length) throw new Error(`${input.company} API: ${body.error?.message ?? `HTTP ${res.status}`}`);
    const message = body.choices[0].message;
    if (message.content?.trim()) transcript.push({ kind: "text", content: message.content.trim() });
    if (!message.tool_calls?.length) return;
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "the arguments were not valid JSON" });
        continue;
      }
      const { content } = await callTool(transcript, run, call.function.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
}

async function main() {
  const input = await readInput();
  const me = await identity();
  const transcript: Turn[] = [];
  let rented: unknown = null;
  let rentals = 0;

  const system = [
    `You are "helper", an AI agent with the registered ANS identity ${me.name}.`,
    `The broker gave you a budget of $${input.budgetUsd} in total, and you may spend at most $${input.rateUsdHr} per hour.`,
    "Use your tools to learn how the broker works, choose a server plan and rent it. Rent at most one server.",
    "When you are done, reply with one or two plain sentences saying what you rented and why.",
  ].join(" ");
  const task = `Rent one server for a short job that needs ${input.need}. Pick the cheapest plan that meets the need and fits your hourly limit.`;
  transcript.push({ kind: "task", content: task });

  const run: Tools = async (name, args) => {
    if (name === "read_agent_card") {
      return JSON.stringify(await (await fetch(`${input.brokerBase}/.well-known/agent-card.json`)).json());
    }
    if (name === "list_plans") {
      return JSON.stringify(await (await fetch(`${input.brokerBase}/api/plans`)).json());
    }
    if (name === "rent_server") {
      if (rentals >= 1) return JSON.stringify({ error: "you already asked for a server in this task" });
      rentals++;
      const leaf = input.chain[input.chain.length - 1];
      const result = await requestProvision({
        url: `${input.brokerBase}/api/provision`,
        chain: input.chain,
        mandate: mandateHash(leaf),
        subject: me.name,
        subjectKey: me,
        plan: String(args.plan),
        region: input.region,
        fetch: await payingFetch(env("AGENT_SOLANA_SECRET_KEY")),
      });
      if (result.status === 200) rented = result.body;
      return JSON.stringify({ status: result.status, body: result.body });
    }
    return JSON.stringify({ error: `unknown tool ${name}` });
  };

  if (input.provider === "anthropic") await anthropicLoop(input, system, task, transcript, run);
  else await openAiLoop(input, system, task, transcript, run);

  return { model: input.modelName, provider: input.company, transcript, rented };
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
