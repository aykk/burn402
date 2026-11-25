import { getSession } from "@/lib/demo/session";
import { checkRequest } from "@/lib/market/session";

/** Pays for the quote shown at the approval stop. The code is passed to the run unchanged. */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { run?: unknown; code?: unknown } | null;
  if (typeof body?.run !== "string" || typeof body.code !== "string") return Response.json({ error: "send the run id and the approval code" }, { status: 400 });
  try {
    const session = await getSession();
    const result = session.approveMarket(body.run, body.code);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ run: result.run });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
