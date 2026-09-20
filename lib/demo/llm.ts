import Anthropic from "@anthropic-ai/sdk";

export type Turn = { kind: "task" | "text" | "tool_call" | "tool_result"; content: string };

export type ToolDef = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
};

export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<string>;

export type LlmRun = {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string | null;
  system: string;
  task: string;
  tools?: ToolDef[];
  run?: ToolRunner;
  maxTurns?: number;
  maxTokens?: number;
};

async function callTool(transcript: Turn[], run: ToolRunner, name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  transcript.push({ kind: "tool_call", content: `${name}(${Object.keys(args).length ? JSON.stringify(args) : ""})` });
  let content: string;
  let isError = false;
  try {
    content = await run(name, args);
  } catch (error) {
    content = (error as Error).message;
    isError = true;
  }
  transcript.push({ kind: "tool_result", content: content.length > 900 ? `${content.slice(0, 900)}…` : content });
  return { content, isError };
}

async function anthropicLoop(options: LlmRun, transcript: Turn[]): Promise<void> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const defs: Anthropic.Tool[] = (options.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: options.task }];
  for (let turn = 0; turn < (options.maxTurns ?? 8); turn++) {
    const response = await client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 8000,
      system: options.system,
      ...(defs.length > 0 ? { tools: defs } : {}),
      messages,
    });
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) transcript.push({ kind: "text", content: block.text.trim() });
    }
    if (response.stop_reason === "refusal") {
      transcript.push({ kind: "text", content: "(the model declined this request)" });
      return;
    }
    if (response.stop_reason !== "tool_use" || !options.run) return;
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const { content, isError } = await callTool(transcript, options.run, block.name, (block.input ?? {}) as Record<string, unknown>);
      results.push({ type: "tool_result", tool_use_id: block.id, content, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

async function openAiLoop(options: LlmRun, transcript: Turn[]): Promise<void> {
  const defs = (options.tools ?? []).map((t) => ({ type: "function", function: t }));
  const messages: ChatMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.task },
  ];
  for (let turn = 0; turn < (options.maxTurns ?? 8); turn++) {
    const res = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model: options.model, messages, ...(defs.length > 0 ? { tools: defs } : {}) }),
    });
    type Reply = { choices?: { message: Extract<ChatMessage, { role: "assistant" }> }[]; error?: { message?: string } };
    const raw = (await res.json().catch(() => ({}))) as Reply | Reply[];
    const body = Array.isArray(raw) ? (raw[0] ?? {}) : raw;
    if (!res.ok || !body.choices?.length) throw new Error(`${options.provider} API: ${body.error?.message ?? `HTTP ${res.status}`}`);
    const message = body.choices[0].message;
    if (message.content?.trim()) transcript.push({ kind: "text", content: message.content.trim() });
    if (!message.tool_calls?.length || !options.run) return;
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "the arguments were not valid JSON" });
        continue;
      }
      const { content } = await callTool(transcript, options.run, call.function.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
}

export async function runLlm(options: LlmRun): Promise<Turn[]> {
  const transcript: Turn[] = [{ kind: "task", content: options.task }];
  if (options.provider === "anthropic") await anthropicLoop(options, transcript);
  else await openAiLoop(options, transcript);
  return transcript;
}

export function lastText(transcript: Turn[]): string {
  return [...transcript].reverse().find((t) => t.kind === "text")?.content ?? "";
}
