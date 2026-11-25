import { getSession } from "@/lib/demo/session";
import { checkRequest, parseRunInput } from "@/lib/market/session";

export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const body: unknown = await request.json().catch(() => null);
  const input = parseRunInput(body);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
  try {
    const session = await getSession();
    return Response.json({ run: await session.startMarketRun(input.value) });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
