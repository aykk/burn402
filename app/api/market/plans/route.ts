import { withoutPaths } from "@/lib/demo/snapshot";
import { checkRequest, isOwner, parsePricesInput, planPreview } from "@/lib/market/session";

/**
 * The plans that fit what the form asks for, read from the seller's price list (cached for a minute).
 * The page calls this as the filters change. Starts no run, quotes nothing, pays nothing.
 */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const body: unknown = await request.json().catch(() => null);
  const input = parsePricesInput(body);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
  const { limits } = input.value;
  if (!limits) return Response.json({ error: "send the budget and the hourly limit" }, { status: 400 });
  if (input.value.market !== "test" && !isOwner(request)) return Response.json({ error: "The public demo lists plans on the test market only." }, { status: 403 });
  try {
    return Response.json({ preview: await planPreview({ ...input.value, limits }) });
  } catch (error) {
    const text = (error as Error).message;
    return Response.json({ error: isOwner(request) ? text : withoutPaths(text) }, { status: 502 });
  }
}
