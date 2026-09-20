import { getSession } from "@/lib/demo/session";
import { registerAgent } from "@/lib/demo/register";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getSession();
  const body = (await request.json()) as { name?: string };
  try {
    const { agent, created } = await registerAgent(String(body.name ?? ""), { ...session.rt.config.registration });
    await session.useAgent(agent);
    return Response.json({ agent: { name: agent.name, ansName: agent.ansName, agentId: agent.agentId }, created });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
