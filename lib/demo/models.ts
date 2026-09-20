import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PROVIDERS = {
  anthropic: { name: "Claude", company: "Anthropic", model: "claude-sonnet-5", modelName: "Claude Sonnet", env: "ANTHROPIC_API_KEY", baseUrl: null },
  openai: { name: "OpenAI", company: "OpenAI", model: "gpt-5", modelName: "GPT-5", env: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" },
  gemini: { name: "Gemini", company: "Google", model: "gemini-2.5-flash", modelName: "Gemini 2.5 Flash", env: "GEMINI_API_KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  deepseek: { name: "DeepSeek", company: "DeepSeek", model: "deepseek-chat", modelName: "DeepSeek V3", env: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com/v1" },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

export type ModelChoice = { provider: ProviderId; model: string; modelName: string; company: string; apiKey: string; baseUrl: string | null };

export type ModelsView = {
  selected: ProviderId;
  providers: { id: ProviderId; name: string; company: string; modelName: string; key: string | null }[];
};

type Store = { selected: ProviderId; keys: Partial<Record<ProviderId, string>> };

const store = ((globalThis as unknown as { __burn402Models?: Store }).__burn402Models ??= { selected: "anthropic", keys: {} });

export function isProvider(id: unknown): id is ProviderId {
  return typeof id === "string" && id in PROVIDERS;
}

function fromEnvFile(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const file = join(process.cwd(), ".env.local");
  if (!existsSync(file)) return undefined;
  return new RegExp(`^${name}=(.+)$`, "m").exec(readFileSync(file, "utf8"))?.[1]?.trim() || undefined;
}

function keyFor(id: ProviderId): string | undefined {
  return store.keys[id] ?? fromEnvFile(PROVIDERS[id].env);
}

export function mask(key: string): string {
  return key.length > 12 ? `${key.slice(0, 2)}…${key.slice(-8)}` : "…";
}

export function selectModel(id: ProviderId, key?: string): void {
  store.selected = id;
  const trimmed = key?.trim();
  if (trimmed) store.keys[id] = trimmed;
}

export function currentModel(): ModelChoice {
  const id = store.selected;
  const p = PROVIDERS[id];
  const apiKey = keyFor(id);
  if (!apiKey) throw new Error(`add a ${p.name} API key first`);
  return { provider: id, model: p.model, modelName: p.modelName, company: p.company, apiKey, baseUrl: p.baseUrl };
}

export function modelsView(): ModelsView {
  return {
    selected: store.selected,
    providers: (Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
      const key = keyFor(id);
      return { id, name: PROVIDERS[id].name, company: PROVIDERS[id].company, modelName: PROVIDERS[id].modelName, key: key ? mask(key) : null };
    }),
  };
}
