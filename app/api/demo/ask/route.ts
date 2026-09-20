import { currentModel, isProvider, modelFor } from "@/lib/demo/models";
import { lastText, runLlm } from "@/lib/demo/llm";

export const dynamic = "force-dynamic";

type Passage = { title: string; url: string; text: string; score: number };

export async function POST(request: Request) {
  const body = (await request.json()) as { question?: string; passages?: Passage[]; provider?: string };
  const question = String(body.question ?? "").trim();
  const passages = (body.passages ?? []).slice(0, 6);
  if (!question) return Response.json({ error: "ask a question first" }, { status: 400 });
  if (passages.length === 0) return Response.json({ error: "the index found nothing to answer from" }, { status: 400 });

  const choice = isProvider(body.provider) ? modelFor(body.provider) : currentModel();
  const sources = passages.map((p, i) => `[${i + 1}] ${p.title || p.url}\n${p.url}\n${p.text}`).join("\n\n");
  try {
    const transcript = await runLlm({
      provider: choice.provider,
      model: choice.model,
      apiKey: choice.apiKey,
      baseUrl: choice.baseUrl,
      system: [
        "You answer questions using only the passages you are given.",
        "Cite the passages you used as [1], [2] and so on, inline, where the claim appears.",
        "If the passages do not answer the question, say so in one sentence and name what they do cover instead. Never invent details.",
        "Answer in at most four sentences, plainly, no preamble.",
      ].join(" "),
      task: `Question: ${question}\n\nPassages:\n${sources}`,
      maxTurns: 1,
      maxTokens: 700,
    });
    return Response.json({
      answer: lastText(transcript),
      model: { name: choice.modelName, company: choice.company },
      cited: passages.map((p, i) => ({ n: i + 1, title: p.title || p.url, url: p.url })),
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 502 });
  }
}
