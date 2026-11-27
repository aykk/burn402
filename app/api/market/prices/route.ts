import { withoutPaths } from "@/lib/demo/snapshot";
import { checkRequest, isOwner, parsePricesInput, priceComparison } from "@/lib/market/session";

/** Market prices beside the cheapest plan the agent can buy. Starts no run, quotes nothing, pays nothing. */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const body: unknown = await request.json().catch(() => null);
  const input = parsePricesInput(body);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
  if (input.value.market !== "test" && !isOwner(request)) return Response.json({ error: "The public demo compares prices on the test market only." }, { status: 403 });
  try {
    return Response.json({ prices: await priceComparison(input.value) });
  } catch (error) {
    const text = (error as Error).message;
    return Response.json({ error: isOwner(request) ? text : withoutPaths(text) }, { status: 500 });
  }
}
