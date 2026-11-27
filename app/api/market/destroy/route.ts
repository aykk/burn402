import { errorFor, visit } from "@/lib/demo/visit";
import { dismissOpenPurchase, visibleOpenPurchases } from "@/lib/market/recover";
import { checkRequest, marketJournal } from "@/lib/market/session";

/**
 * { run } destroys the current run's machine, { run, cancel: true } cancels at the approval stop, { open: { run } } destroys a
 * journal-recovered machine, and { open: { run }, dismiss: true } closes an open purchase that has no machine (the owner checked it).
 */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { run?: unknown; cancel?: unknown; dismiss?: unknown; open?: { run?: unknown } | null } | null;
  if (!body || typeof body !== "object") return Response.json({ error: "send the run to destroy" }, { status: 400 });
  const run = typeof body.run === "string" ? body.run : undefined;
  const open = body.open && typeof body.open.run === "string" ? { run: body.open.run } : undefined;
  if (!run && !open) return Response.json({ error: "send the run to destroy" }, { status: 400 });
  const who = await visit(request, { create: false });
  if (who instanceof Response) return who;
  const session = who.session;
  if (!session) return Response.json({ error: "that run is not the current run" }, { status: 400 });
  try {
    if (body.dismiss === true) {
      if (!open) return Response.json({ error: "Only a purchase from the open purchases list can be dismissed." }, { status: 400 });
      const journal = marketJournal(session.rt.config.root);
      // the list the page shows: the current run is not on it while it is still going; a public visitor's list holds their own runs only
      const entry = visibleOpenPurchases(journal.open(), session.market?.view() ?? null).find((o) => o.run === open.run && (session.kind === "owner" || session.runIds.has(o.run)));
      if (!entry) return Response.json({ error: "That purchase is not on the open purchases list any more." }, { status: 400 });
      const result = dismissOpenPurchase(entry, journal);
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
      session.log.push("info", "MARKET", `run ${entry.run}: dismissed by owner`);
      return Response.json({ ok: true, message: result.message });
    }
    const result = await session.destroyMarket({ run, cancel: body.cancel === true, open });
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json(result.message ? { ok: true, message: result.message } : { ok: true });
  } catch (error) {
    return Response.json({ error: errorFor(who.v, error) }, { status: 400 });
  }
}
