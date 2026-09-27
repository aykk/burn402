import { getSession } from "@/lib/demo/session";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session.rt.gate) return Response.json({ error: "x402 is not configured on this broker" }, { status: 503 });
  try {
    return await session.rt.gate.handle(request);
  } catch (error) {
    // an empty 500 leaves the caller unable to tell a refusal from a crash, and
    // the box may already be running by the time this fires
    const detail = error instanceof Error ? error.message : String(error);
    session.rt.log.push("error", "PROVISION", detail);
    return Response.json({ error: `the broker failed while provisioning: ${detail}` }, { status: 500 });
  }
}
