import { publicLimit } from "@/lib/demo/limits";
import { errorFor, visit } from "@/lib/demo/visit";
import { checkRequest } from "@/lib/market/session";

/**
 * What a connected wallet is asked to sign. Sends and pays nothing by itself.
 *  - { run, code }: the approval at the approval stop, permission for this run's agent to move exactly the
 *    quoted amount of USDC. Returns the unsigned transaction. Needs the run's one-time code.
 *  - { run, revoke: true }: once the run is over, whether the wallet still lets the agent move anything;
 *    if so, the unsigned transaction that takes it back.
 *  - { run, revoke: true, signedTransaction }: checks the revoke the wallet signed and puts it on chain.
 * A run an Ethereum wallet pays for itself, on Base:
 *  - { run, code }: returns the message that wallet signs instead (USDC, exactly the quoted amount, to the seller)
 *    and the network it must be on.
 *  - { run, signIn: "look" | "destroy" }: the sign-in message the wallet signs to look at, or destroy, its machine.
 *  - { run, signIn, signature }: uses that signed sign-in, once. Returns the run.
 * All of it only works in the session that owns the run.
 */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { run?: unknown; code?: unknown; revoke?: unknown; signedTransaction?: unknown; signIn?: unknown; signature?: unknown } | null;
  if (typeof body?.run !== "string") return Response.json({ error: "send the run id" }, { status: 400 });
  const who = await visit(request, { create: false });
  if (who instanceof Response) return who;
  if (!who.session) return Response.json({ error: "that run is not the current run" }, { status: 400 });
  // each of these asks the Solana node: a public visitor gets a fair number an hour
  const limited = publicLimit("wallet", who.v);
  if (limited) return Response.json({ error: limited }, { status: 429 });
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
    if (body.signIn === "look" || body.signIn === "destroy") {
      if (typeof body.signature === "string") {
        const used = await who.session.useWalletSignIn(body.run, body.signIn, body.signature);
        return used.ok ? Response.json({ run: used.run }) : Response.json({ error: used.error }, { status: 400 });
      }
      const ask = who.session.walletSignInMessage(body.run, body.signIn);
      return ask.ok ? Response.json({ message: ask.message, wallet: ask.wallet }) : Response.json({ error: ask.error }, { status: 400 });
    }
    if (typeof body.code !== "string") return Response.json({ error: "send the run id and the approval code" }, { status: 400 });
    if (who.session.market?.view().selfManaged) {
      const typed = await who.session.walletTypedPayment(body.run, body.code);
      if (!typed.ok) return Response.json({ error: typed.error }, { status: 400 });
      return Response.json({ typedData: typed.typedData, network: typed.network, wallet: typed.wallet });
    }
    const result = await who.session.walletApproval(body.run, body.code);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ transaction: result.transaction, chain: result.chain, wallet: result.wallet });
  } catch (error) {
    return Response.json({ error: errorFor(who.v, error) }, { status: 400 });
  }
}
