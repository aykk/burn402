export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const base = new URL(request.url).origin;
  return Response.json({
    name: "burn402 broker",
    description:
      "Rents cloud servers for agents that hold a burn402 budget. Every request must carry the agent's budget chain and be signed by the agent it was issued to. Payment is taken over x402 only after the budget check passes.",
    url: base,
    version: "1.0.0",
    protocolVersion: "1.0",
    provider: { organization: "burn402", url: base },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "list_plans",
        name: "List server plans",
        description: "Server plans the broker can rent, with specs and hourly price in USD.",
        tags: ["compute", "pricing"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        "x-endpoint": { method: "GET", url: `${base}/api/plans` },
      },
      {
        id: "rent_server",
        name: "Rent a server",
        description:
          "Rent one server. The broker refuses plans above the budget's hourly limit and requests after the budget runs out. The server is shut down when the budget is used up.",
        tags: ["compute", "x402"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        "x-endpoint": { method: "POST", url: `${base}/api/provision` },
        "x-payment": { protocol: "x402", scheme: "exact", network: "solana-devnet", asset: "USDC" },
      },
    ],
    "x-identity": { ans: "ans://v1.0.0.broker.burn402.xyz" },
  });
}
