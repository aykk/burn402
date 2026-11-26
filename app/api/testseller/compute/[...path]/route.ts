import { isOwner } from "@/lib/market/session";
import { getTestSeller } from "@/lib/market/testseller";

export const dynamic = "force-dynamic";

/**
 * The test seller's API. Only this app calls it, from this computer (the run talks to it at
 * 127.0.0.1): a public visitor reaches the test market through a run, never the seller directly.
 */
function handle(request: Request): Promise<Response> | Response {
  if (!isOwner(request)) return Response.json({ error: "not found" }, { status: 404 });
  const seller = getTestSeller();
  if (!seller) return Response.json({ error: "the test seller is off (it needs SOLANA_RECEIVER_ADDRESS, and BURN402_TEST_SELLER=1 in a production build)" }, { status: 503 });
  return seller.handle(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
