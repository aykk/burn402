import { getSession } from "@/lib/demo/session";
import { checkRequest } from "@/lib/market/session";

/** { run } destroys the current run's machine, { run, cancel: true } cancels at the approval stop, { open: { run } } destroys a journal-recovered machine. */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { run?: unknown; cancel?: unknown; open?: { run?: unknown } | null } | null;
  if (!body || typeof body !== "object") return Response.json({ error: "send the run to destroy" }, { status: 400 });
  const run = typeof body.run === "string" ? body.run : undefined;
  const open = body.open && typeof body.open.run === "string" ? { run: body.open.run } : undefined;
  if (!run && !open) return Response.json({ error: "send the run to destroy" }, { status: 400 });
  try {
    const session = await getSession();
    const result = await session.destroyMarket({ run, cancel: body.cancel === true, open });
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
