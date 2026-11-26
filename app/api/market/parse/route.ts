import { lastText, runLlm } from "@/lib/demo/llm";
import { currentModel, type ModelChoice } from "@/lib/demo/models";
import { NOT_PUBLIC } from "@/lib/market/access";
import { checkRequest, isOwner, needFromModelReply } from "@/lib/market/session";

const SYSTEM = [
  "You turn a short description of a compute need into form fields. Reply with one JSON object and nothing else.",
  'Fields (omit any the description does not imply): "kind" ("cpu" or "gpu"), "vcpus" (whole number 1-64), "ramGb" (0.5-512),',
  '"vramGb" (GPU memory in GB, 0-200), "hours" (1/60-72), "regions" (list of lowercase region codes such as "ewr" or "fra"),',
  '"allowSpot" (true if interruptible machines are fine), and "note" (one short sentence restating the need).',
  "Do not choose a provider, plan or price.",
].join(" ");

/** Fills the form from plain English. The model only suggests fields; the run never depends on it. */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  // the model key is the owner's: a public visitor never spends it
  if (!isOwner(request)) return Response.json({ error: NOT_PUBLIC }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "describe what you need first" }, { status: 400 });
  if (text.length > 1000) return Response.json({ error: "keep the description under 1000 characters" }, { status: 400 });
  let model: ModelChoice;
  try {
    model = currentModel();
  } catch {
    return Response.json({ error: "add a model key first" }, { status: 400 });
  }
  try {
    const transcript = await runLlm({ provider: model.provider, model: model.model, apiKey: model.apiKey, baseUrl: model.baseUrl, system: SYSTEM, task: text, maxTurns: 1, maxTokens: 1000 });
    return Response.json(needFromModelReply(lastText(transcript)));
  } catch (error) {
    return Response.json({ error: `the model could not read that: ${(error as Error).message}` }, { status: 400 });
  }
}
