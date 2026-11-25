import { getSession } from "@/lib/demo/session";
import { OVERSPEND_BUSY, overspendRunning } from "@/lib/market/overspend-lock";
import { checkRequest, parseRunInput } from "@/lib/market/session";

export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  if (overspendRunning()) return Response.json({ error: OVERSPEND_BUSY }, { status: 409 });
  const body: unknown = await request.json().catch(() => null);
  const input = parseRunInput(body);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
  try {
    const session = await getSession();
    return Response.json({ run: await session.startMarketRun(input.value) });
  } catch (error) {
    const message = (error as Error).message;
    return Response.json({ error: message }, { status: message === OVERSPEND_BUSY ? 409 : 400 });
  }
}
