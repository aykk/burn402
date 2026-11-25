import { getTestSeller } from "@/lib/market/testseller";

export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> | Response {
  const seller = getTestSeller();
  if (!seller) return Response.json({ error: "the test seller needs SOLANA_RECEIVER_ADDRESS" }, { status: 503 });
  return seller.handle(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
