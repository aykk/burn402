import { historyFor, type AnchorPolicy } from "../anchor";
import { fqdnOf } from "../auditor";
import { behaviorObservation, type Observation } from "./behavior";
import type { TrustAgent, TrustIndexClient } from "./client";

export type TrackedAgent = {
  agentId: string;
  ansName: string;
  displayName?: string;
  description?: string;
};

export type BehaviorSync = {
  agentId: string;
  fqdn: string;
  breaches: number;
  observation: Observation;
};

export async function syncBehavior(options: {
  trustIndex: TrustIndexClient;
  anchor: AnchorPolicy;
  gatewayUrl: string;
  agents: TrackedAgent[];
  now?: () => Date;
}): Promise<BehaviorSync[]> {
  const now = options.now ?? (() => new Date());
  const stamp = now().toISOString().replace(/\.\d{3}Z$/, "Z");

  const agents: TrustAgent[] = options.agents.map((a) => ({
    agentId: a.agentId,
    dnsName: fqdnOf(a.ansName),
    displayName: a.displayName ?? fqdnOf(a.ansName),
    description: a.description ?? `burn402 agent ${a.ansName}`,
    providerId: "burn402",
    status: "ACTIVE",
    protocols: ["MCP"],
    transports: ["SSE"],
    tags: ["burn402"],
    capabilities: [],
    firstSeen: stamp,
    lastUpdated: stamp,
  }));
  await options.trustIndex.importAgents(agents);

  const results: BehaviorSync[] = [];
  for (const a of options.agents) {
    const fqdn = fqdnOf(a.ansName);
    const history = await historyFor(options.anchor, fqdn);
    const observation = behaviorObservation(a.agentId, history, options.gatewayUrl, now());
    results.push({ agentId: a.agentId, fqdn, breaches: history.entries.filter((e) => e.verdict.verdict === "BREACH").length, observation });
  }
  await options.trustIndex.importObservations(results.map((r) => r.observation));
  return results;
}
