import { publicLimit } from "@/lib/demo/limits";
import { visit } from "@/lib/demo/visit";
import { PUBLIC_MAX_BUDGET_USD, PUBLIC_TEST_ONLY } from "@/lib/market/access";
import { OVERSPEND_BUSY, overspendRunning } from "@/lib/market/overspend-lock";
import { checkRequest, parseRunInput } from "@/lib/market/session";

export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  if (overspendRunning()) return Response.json({ error: OVERSPEND_BUSY }, { status: 409 });
  const body: unknown = await request.json().catch(() => null);
  const input = parseRunInput(body);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
  // looked up before a session is made, so a refused start does not cost one
  const seen = await visit(request, { create: false });
  if (seen instanceof Response) return seen;
  if (seen.v.kind === "public") {
    // the real market spends the owner's wallet: never for a public visitor
    if (input.value.market !== "test") return Response.json({ error: PUBLIC_TEST_ONLY }, { status: 403 });
    if (input.value.limits.budgetUsd > PUBLIC_MAX_BUDGET_USD) return Response.json({ error: `The public demo allows a budget of up to $${PUBLIC_MAX_BUDGET_USD.toFixed(2)}.` }, { status: 400 });
    // a visitor whose run is still going gets it back and is not counted again
    if (!seen.session?.marketBusy) {
      const limited = publicLimit("run", seen.v);
      if (limited) return Response.json({ error: limited }, { status: 429 });
    }
  }
  const who = await visit(request, { create: true });
  if (who instanceof Response) return who;
  try {
    return Response.json({ run: await who.session!.startMarketRun(input.value) });
  } catch (error) {
    const message = (error as Error).message;
    return Response.json({ error: message }, { status: message === OVERSPEND_BUSY ? 409 : 400 });
  }
}
