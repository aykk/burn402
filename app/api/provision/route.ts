import { getSession } from "@/lib/demo/session";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session.rt.gate) return Response.json({ error: "x402 is not configured on this broker" }, { status: 503 });
  return session.rt.gate.handle(request);
}
