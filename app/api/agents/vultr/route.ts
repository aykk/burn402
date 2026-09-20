import { VultrResource, type CatalogPlan } from "@/lib/burn";
import { getSession } from "@/lib/demo/session";
import { currentModel } from "@/lib/demo/models";
import { lastText, runLlm } from "@/lib/demo/llm";
import { signJws, toCompact, verifyJws } from "@/lib/mandate";
import { A2A_TYP, offerFor, vultrSystemPrompt, vultrTask, type A2ARequest, type Offer } from "@/lib/train";

export const dynamic = "force-dynamic";

const FALLBACK_PLANS: CatalogPlan[] = [
  { id: "vc2-1c-1gb", family: "vc2", vcpus: 1, ramGb: 1, diskGb: 25, hourlyUsd: 0.007, monthlyUsd: 5 },
  { id: "vc2-2c-4gb", family: "vc2", vcpus: 2, ramGb: 4, diskGb: 80, hourlyUsd: 0.027, monthlyUsd: 20 },
  { id: "vc2-4c-8gb", family: "vc2", vcpus: 4, ramGb: 8, diskGb: 160, hourlyUsd: 0.055, monthlyUsd: 40 },
];

export async function POST(request: Request) {
  const session = await getSession();
  const rt = session.rt;
  const body = (await request.json()) as { protected: string; payload: string; signature: string };

  let message: A2ARequest;
  try {
    const checked = await verifyJws(body, (iss) => rt.directory.resolveKeys(iss), A2A_TYP);
    message = checked.payload as A2ARequest;
  } catch (error) {
    return Response.json({ error: `that message did not verify: ${(error as Error).message}` }, { status: 403 });
  }

  const run = session.jobFor(message.conv);
  if (!run) return Response.json({ error: `no open job called ${message.conv}` }, { status: 404 });
  if (message.aud !== rt.actors.vultr.name) return Response.json({ error: "that message is addressed to someone else" }, { status: 400 });

  const counter = message.kind === "counter" ? message : null;
  run.record({
    from: message.iss,
    fromLabel: "company",
    to: message.aud,
    kind: message.kind,
    text: counter ? counter.ask : message.kind === "quote_request" ? message.note || run.brief.request : "",
    signed: body.signature.slice(0, 16),
    verified: true,
  });

  const plans = rt.resource.kind === "vultr" ? await (rt.resource as VultrResource).catalog(rt.config.region) : FALLBACK_PLANS;
  const { quotes, chosen, reason } = offerFor({
    spec: run.spec,
    plans,
    brief: run.brief,
    prepayHours: rt.config.prepayHours,
    limits: counter ? { maxSeconds: counter.maxSeconds, maxUsd: counter.maxUsd } : undefined,
  });
  run.quotes = quotes;
  if (chosen) {
    run.chosen = chosen;
    run.chosenReason = reason;
  }

  const choice = currentModel();
  let text: string;
  try {
    const transcript = await runLlm({
      provider: choice.provider,
      model: choice.model,
      apiKey: choice.apiKey,
      baseUrl: choice.baseUrl,
      system: vultrSystemPrompt(rt.config.region),
      task: vultrTask(run.brief, quotes, chosen, reason, counter?.ask ?? null),
      maxTurns: 1,
      maxTokens: 700,
    });
    text = lastText(transcript) || reason;
  } catch (error) {
    text = `${reason}. (the desk's model was unavailable: ${(error as Error).message})`;
  }

  const offer: Offer = {
    conv: message.conv,
    kind: counter ? "revised_quote" : "quote",
    iss: rt.actors.vultr.name,
    aud: message.iss,
    at: Math.floor(Date.now() / 1000),
    quotes,
    recommend: chosen?.plan ?? null,
    reason,
    text,
  };
  const signed = await signJws(offer, rt.actors.vultr, A2A_TYP);
  run.record({
    from: offer.iss,
    fromLabel: "vultr",
    to: offer.aud,
    kind: offer.kind,
    text,
    signed: signed.signature.slice(0, 16),
    verified: true,
  });

  return Response.json({ offer, jws: toCompact(signed) });
}
