import type { Journal, OpenPurchase } from "./journal";
import { usdPlain } from "./money";
import type { MarketPhase, MarketRun, MarketRunView } from "./run";
import type { SellerClient } from "./seller";

/** Machine management only: this module never quotes, pays or creates anything. */
type Manage = Pick<SellerClient, "destroy" | "instance" | "instances">;

export type RecoverResult = { ok: true; destroyed: string[]; message: string } | { ok: false; error: string };

/**
 * Destroys the machine behind a journal purchase that is still open (a restart left it, or the
 * run lost track of it). With no machine id on record and a last event of intent or unknown (the
 * payment's outcome was never learned), the wallet's live machines with the same plan and region are destroyed instead, except any
 * id in `exclude` (machines that belong to other runs). When none match and only an intent was
 * recorded, the purchase is closed in the journal as failed: nothing is running for it. A payment
 * that was sent (unknown) with no machine stays open: the money may be out. A paid entry with no
 * machine (the seller kept the payment) is never searched: nothing is destroyed or journaled.
 */
export async function destroyOpenPurchase(open: OpenPurchase, seller: Manage, journal: Journal, opts: { exclude?: Set<string>; now?: () => number } = {}): Promise<RecoverResult> {
  const now = opts.now ?? Date.now;
  const exclude = opts.exclude ?? new Set<string>();
  if (!open.instance && open.lastEvent !== "intent" && open.lastEvent !== "unknown") {
    // the app learned the seller kept the payment and sent no machine: any matching machine is someone else's
    return { ok: true, destroyed: [], message: "The seller kept this payment and delivered no machine, so there is nothing to destroy. Use Dismiss to clear it from this list." };
  }
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
 * The owner closes an open purchase that has no machine (a payment the seller kept, or one never
 * confirmed) after checking it themselves. One journal line records it; nothing is destroyed or paid.
 * Only an entry with no machine whose last event is paid or unknown can be dismissed: one with a
 * machine on record has to be destroyed, and an intent-only entry has its machine looked for by Destroy.
 */
export function dismissOpenPurchase(open: OpenPurchase, journal: Journal, opts: { now?: () => number } = {}): RecoverResult {
  if (open.instance) return { ok: false, error: `This purchase has a machine on record (${open.instance}). Destroy it instead; it cannot be dismissed.` };
  if (open.lastEvent !== "paid" && open.lastEvent !== "unknown") {
    return { ok: false, error: "No payment was recorded for this purchase yet, so there is nothing to dismiss. Use Destroy to look for its machine." };
  }
  const now = opts.now ?? Date.now;
  journal.append({ at: now(), run: open.run, market: open.market, seller: open.seller, event: "failed", plan: open.plan, region: open.region, usd: open.usd, tx: open.tx, instance: null, detail: "dismissed by owner" });
  return { ok: true, destroyed: [], message: "Dismissed. The purchase journal keeps a line saying you dismissed it." };
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

export const RESET_WHILE_PAYING = "A payment is in progress. Wait for it to finish before resetting.";

/** A reset is refused while the current run is paying or provisioning: it would drop a purchase in flight. */
export function resetRefusal(run: { view: () => Pick<MarketRunView, "phase" | "market"> } | null): string | null {
  if (!run) return null;
  const { phase } = run.view();
  return phase === "paying" || phase === "provisioning" ? RESET_WHILE_PAYING : null;
}

const ENDED: ReadonlySet<MarketPhase> = new Set(["released", "failed", "refused"]);

/** Open journal purchases for the page. The current run is left out only while it is still going (the run view shows it); once it has ended with money out, it is listed. */
export function visibleOpenPurchases(open: OpenPurchase[], current: Pick<MarketRunView, "id" | "phase"> | null): OpenPurchase[] {
  return open.filter((o) => !(current && o.run === current.id && !ENDED.has(current.phase)));
}
