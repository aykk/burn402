import type { History } from "../anchor";

export const BEHAVIOR_SIGNAL = "burn402.behavior.score";
export const AIM_ID = "burn402";

export type BehaviorValue = {
  score: number;
  riskCodes: string[];
  explanation: string;
};

export type Observation = {
  agentId: string;
  signalId: string;
  observedAt: string;
  value: BehaviorValue;
  provenance?: { aimId: string; evidenceUrl: string };
};

export function behaviorScore(breaches: number): number {
  return Math.round(100 * 0.5 ** breaches);
}

export function riskCode(failureMode: string): string {
  return `BEHAVIOR_BURN402_${failureMode.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export function behaviorObservation(agentId: string, history: History, gatewayUrl: string, observedAt: Date): Observation {
  const breaches = history.entries.filter((e) => e.verdict.verdict === "BREACH");
  const modes = [...new Set(breaches.map((e) => e.verdict.failure_mode).filter((m): m is NonNullable<typeof m> => m !== null))];
  const latest = breaches[breaches.length - 1];
  const explanation = latest
    ? `${breaches.length} anchored breach${breaches.length === 1 ? "" : "es"} for ${history.fqdn}; latest ${latest.verdict.failure_mode} by ${latest.verdict.iss} (ar://${latest.id})`
    : `no anchored breaches for ${history.fqdn}`;

  const observation: Observation = {
    agentId,
    signalId: BEHAVIOR_SIGNAL,
    observedAt: observedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    value: { score: behaviorScore(breaches.length), riskCodes: modes.slice(0, 16).map(riskCode), explanation },
  };
  if (latest) observation.provenance = { aimId: AIM_ID, evidenceUrl: `${gatewayUrl.replace(/\/$/, "")}/${latest.id}` };
  return observation;
}
