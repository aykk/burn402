import type { UsageRecord } from "../auditor";
import type { LiveInstance, Resource } from "./resource";

export type SettledLease = {
  handle: string;
  mandateJti: string | null;
  plan: string;
  usd: number | null;
  tx: string | null;
};

export type Reconciliation = {
  live: LiveInstance[];
  settled: string[];
  unattributed: LiveInstance[];
  observedAt: number;
};

export async function reconcile(options: { resource: Resource; settled: SettledLease[]; observedAt?: number }): Promise<Reconciliation> {
  if (!options.resource.listTagged) throw new Error(`${options.resource.kind} cannot list what it has running`);
  const live = await options.resource.listTagged();
  const paid = new Set(options.settled.filter((s) => s.tx !== null && (s.usd ?? 0) > 0).map((s) => s.handle));
  return {
    live,
    settled: [...paid],
    unattributed: live.filter((i) => !paid.has(i.id)),
    observedAt: options.observedAt ?? Math.floor(Date.now() / 1000),
  };
}

export async function usageFor(options: {
  resource: Resource;
  instances: LiveInstance[];
  mandateJti: string;
  observedAt: number;
}): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  for (const i of options.instances) {
    out.push({
      mandate_jti: options.mandateJti,
      handle: i.id,
      plan: i.plan,
      hourly_usd: await options.resource.quote({ plan: i.plan, region: i.region }),
      started_at: Math.floor(i.createdAt),
      ended_at: null,
    });
  }
  return out;
}
