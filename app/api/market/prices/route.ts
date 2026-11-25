import { checkRequest, parsePricesInput, priceComparison } from "@/lib/market/session";

/** Market prices beside the cheapest plan the agent can buy. Starts no run, quotes nothing, pays nothing. */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const body: unknown = await request.json().catch(() => null);
  const input = parsePricesInput(body);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
  try {
    return Response.json({ prices: await priceComparison(input.value) });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
