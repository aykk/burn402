import { errorFor, visit } from "@/lib/demo/visit";
import { checkRequest } from "@/lib/market/session";

/**
 * The approval a connected wallet is asked to sign at the approval stop: permission for this run's agent to
 * move exactly the quoted amount of USDC. Returns the unsigned transaction; sends and pays nothing. It only
 * works in the session that owns the run, with the run's one-time code.
 */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { run?: unknown; code?: unknown } | null;
  if (typeof body?.run !== "string" || typeof body.code !== "string") return Response.json({ error: "send the run id and the approval code" }, { status: 400 });
  const who = await visit(request, { create: false });
  if (who instanceof Response) return who;
  if (!who.session) return Response.json({ error: "that run is not the current run" }, { status: 400 });
  try {
    const result = await who.session.walletApproval(body.run, body.code);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ transaction: result.transaction, chain: result.chain, wallet: result.wallet });
  } catch (error) {
    return Response.json({ error: errorFor(who.v, error) }, { status: 400 });
  }
}
