import { errorFor, visit } from "@/lib/demo/visit";
import { checkRequest } from "@/lib/market/session";

/**
 * What a connected wallet is asked to sign. Sends and pays nothing by itself.
 *  - { run, code }: the approval at the approval stop, permission for this run's agent to move exactly the
 *    quoted amount of USDC. Returns the unsigned transaction. Needs the run's one-time code.
 *  - { run, revoke: true }: once the run is over, whether the wallet still lets the agent move anything;
 *    if so, the unsigned transaction that takes it back.
 *  - { run, revoke: true, signedTransaction }: checks the revoke the wallet signed and puts it on chain.
 * All of it only works in the session that owns the run.
 */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { run?: unknown; code?: unknown; revoke?: unknown; signedTransaction?: unknown } | null;
  if (typeof body?.run !== "string") return Response.json({ error: "send the run id" }, { status: 400 });
  const who = await visit(request, { create: false });
  if (who instanceof Response) return who;
  if (!who.session) return Response.json({ error: "that run is not the current run" }, { status: 400 });
  try {
    if (body.revoke === true) {
      if (typeof body.signedTransaction === "string") {
        const sent = await who.session.sendWalletRevoke(body.run, body.signedTransaction);
        return sent.ok ? Response.json({ ok: true }) : Response.json({ error: sent.error }, { status: 400 });
      }
      const left = await who.session.walletRevoke(body.run);
      if (!left.ok) return Response.json({ error: left.error }, { status: 400 });
      return Response.json(left.none ? { none: true } : { none: false, transaction: left.transaction, chain: left.chain, wallet: left.wallet, exact: left.exact });
    }
    if (typeof body.code !== "string") return Response.json({ error: "send the run id and the approval code" }, { status: 400 });
    const result = await who.session.walletApproval(body.run, body.code);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ transaction: result.transaction, chain: result.chain, wallet: result.wallet });
  } catch (error) {
    return Response.json({ error: errorFor(who.v, error) }, { status: 400 });
  }
}
