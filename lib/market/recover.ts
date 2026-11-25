import type { Journal, OpenPurchase } from "./journal";
import { usdPlain } from "./money";
import type { MarketPhase, MarketRun, MarketRunView } from "./run";
import type { SellerClient } from "./seller";

/** Machine management only: this module never quotes, pays or creates anything. */
type Manage = Pick<SellerClient, "destroy" | "instance" | "instances">;

export type RecoverResult = { ok: true; destroyed: string[]; message: string } | { ok: false; error: string };

/**
 * Destroys the machine behind a journal purchase that is still open (a restart left it, or the
 * run lost track of it). With no machine id on record (only an intent, or an unknown outcome),
 * the wallet's live machines with the same plan and region are destroyed instead, except any
 * id in `exclude` (machines that belong to other runs). When none match and only an intent was
 * recorded, the purchase is closed in the journal as failed: nothing is running for it. A payment
 * that was sent (paid or unknown) with no machine stays open: the money may be out.
 */
export async function destroyOpenPurchase(open: OpenPurchase, seller: Manage, journal: Journal, opts: { exclude?: Set<string>; now?: () => number } = {}): Promise<RecoverResult> {
  const now = opts.now ?? Date.now;
  const exclude = opts.exclude ?? new Set<string>();
  let ids: string[];
  try {
    ids = open.instance
      ? [open.instance]
      : (await seller.instances()).filter((i) => i.plan === open.plan && i.region === open.region && i.status !== "destroyed" && !exclude.has(i.id)).map((i) => i.id);
  } catch (error) {
    return { ok: false, error: `Could not list the wallet's machines: ${(error as Error).message}` };
  }
  const base = { run: open.run, market: open.market, seller: open.seller, plan: open.plan, region: open.region, usd: open.usd, tx: open.tx };
  if (ids.length === 0 && (open.lastEvent === "paid" || open.lastEvent === "unknown")) {
    const usd = usdPlain(open.usd);
    const which = open.lastEvent === "paid" ? `The seller kept the payment of ${usd} and delivered no machine.` : `The payment of ${usd} may have gone through; no machine was found for it.`;
    return { ok: true, destroyed: [], message: `There is no machine to destroy for this purchase. ${which} It stays on the list.` };
  }
  if (ids.length === 0) {
    journal.append({ ...base, at: now(), event: "failed", instance: null, detail: "no machine found for this payment" });
    return { ok: true, destroyed: [], message: `No machine is running for that payment (${open.plan} in ${open.region}); it is closed` };
  }
  for (const id of ids) {
    try {
      await seller.destroy(id);
      const after = await seller.instance(id);
      if (after && after.status !== "destroyed") throw new Error(`the seller still lists ${id} as ${after.status}`);
    } catch (error) {
      return { ok: false, error: `Destroy failed, the machine may still be running: ${(error as Error).message}` };
    }
  }
  journal.append({ ...base, at: now(), event: "released", instance: ids[0], detail: `destroyed from the open purchases list: ${ids.join(", ")}` });
  return { ok: true, destroyed: ids, message: `Destroyed ${ids.join(", ")}` };
}

/**
 * What a session reset does with the current run. Nothing was signed at the approval stop, so
 * that is cancelled; a test-market machine is destroyed. A real-market machine is never destroyed
 * automatically: it stays in the journal and is listed with the open purchases.
 */
export async function settleOnReset(run: Pick<MarketRun, "view" | "cancel" | "destroy"> | null): Promise<"cancelled" | "destroyed" | "kept" | "none"> {
  if (!run) return "none";
  const v = run.view();
  if (v.phase === "approval") {
    run.cancel();
    return "cancelled";
  }
  if (v.market === "test") {
    await run.destroy();
    return "destroyed";
  }
  return "kept";
}

const ENDED: ReadonlySet<MarketPhase> = new Set(["released", "failed", "refused"]);

/** Open journal purchases for the page. The current run is left out only while it is still going (the run view shows it); once it has ended with money out, it is listed. */
export function visibleOpenPurchases(open: OpenPurchase[], current: Pick<MarketRunView, "id" | "phase"> | null): OpenPurchase[] {
  return open.filter((o) => !(current && o.run === current.id && !ENDED.has(current.phase)));
}
