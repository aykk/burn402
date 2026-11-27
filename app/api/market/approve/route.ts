import { publicLimit } from "@/lib/demo/limits";
import { errorFor, visit } from "@/lib/demo/visit";
import { checkRequest } from "@/lib/market/session";

/**
 * Pays for the quote shown at the approval stop. The code is passed to the run unchanged; it only works in the
 * session that owns the run. A run paid from a connected wallet also sends the approval that wallet signed.
 */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { run?: unknown; code?: unknown; signedTransaction?: unknown } | null;
  if (typeof body?.run !== "string" || typeof body.code !== "string") return Response.json({ error: "send the run id and the approval code" }, { status: 400 });
  const who = await visit(request, { create: false });
  if (who instanceof Response) return who;
  if (!who.session) return Response.json({ error: "that run is not the current run" }, { status: 400 });
  // sending a wallet's approval asks the Solana node: a public visitor gets a fair number an hour
  if (typeof body.signedTransaction === "string") {
    const limited = publicLimit("wallet", who.v);
    if (limited) return Response.json({ error: limited }, { status: 429 });
  }
  try {
    const result = await who.session.approveMarket(body.run, body.code, typeof body.signedTransaction === "string" ? body.signedTransaction : undefined);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ run: result.run });
  } catch (error) {
    return Response.json({ error: errorFor(who.v, error) }, { status: 400 });
  }
}
