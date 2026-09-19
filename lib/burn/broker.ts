import type { MandateRegistry, RefusalCode } from "../mandate";
import type { Resource, Spec } from "./resource";

export const PROVISION_SCOPE = "compute:provision";

export type Lease = {
  handle: string;
  mandate: string;
  spec: Spec;
  hourlyUsd: number;
  startedAt: number;
};

export type ProvisionRefusal = {
  code: RefusalCode | "PROVIDER_ERROR";
  detail: string;
};

export type ReapReason = "BUDGET_EXHAUSTED" | "MANDATE_EXPIRED";

export type BurnEvent =
  | {
      type: "PROVISION_FAILED";
      at: number;
      mandate: string;
      plan: string;
      code: "PROVIDER_ERROR";
      detail: string;
    }
  | {
      type: "PROVISION_REFUSED";
      at: number;
      mandate: string;
      plan: string;
      code: RefusalCode;
      detail: string;
    }
  | {
      type: "RESOURCE_PROVISIONED";
      at: number;
      mandate: string;
      handle: string;
      plan: string;
      hourly_usd: number;
      effective_exp: number;
    }
  | {
      type: "RESOURCE_REAPED";
      at: number;
      mandate: string;
      handle: string;
      reason: ReapReason;
      charged_usd: number;
    }
  | {
      type: "RESOURCE_RELEASED";
      at: number;
      mandate: string;
      handle: string;
      charged_usd: number;
    };

export type ProvisionResult = { ok: true; lease: Lease } | { ok: false; refusal: ProvisionRefusal };

export type MandateStatus = {
  mandate: string;
  jti: string;
  limit_usd: number;
  rate_usd_hr: number;
  allocated_usd: number;
  consumed_usd: number;
  consumed_with_descendants_usd: number;
  remaining_usd: number;
  burn_usd_hr: number;
  runtime_left_hr: number;
  exp: number;
  effective_exp: number;
  leases: string[];
};

export type BrokerOptions = {
  registry: MandateRegistry;
  resource: Resource;
  now: () => number;
  onEvent?: (event: BurnEvent) => void;
};

const EPSILON = 1e-9;

export class Broker {
  private readonly registry: MandateRegistry;
  private readonly resource: Resource;
  private readonly now: () => number;
  private readonly onEvent?: (event: BurnEvent) => void;
  private readonly leases = new Map<string, Lease>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: BrokerOptions) {
    this.registry = options.registry;
    this.resource = options.resource;
    this.now = options.now;
    this.onEvent = options.onEvent;
    this.registry.attachMeter((hash) => this.accrued(hash, this.now()));
  }

  leasesOf(hash: string): Lease[] {
    return [...this.leases.values()].filter((l) => l.mandate === hash);
  }

  burnRate(hash: string): number {
    return this.leasesOf(hash).reduce((sum, l) => sum + l.hourlyUsd, 0);
  }

  accrued(hash: string, at: number): number {
    return this.leasesOf(hash).reduce((sum, l) => sum + (l.hourlyUsd * Math.max(0, at - l.startedAt)) / 3600, 0);
  }

  consumedWithDescendants(hash: string): number {
    const own = this.registry.settled(hash) + this.accrued(hash, this.now());
    return this.registry.childrenOf(hash).reduce((sum, child) => sum + this.consumedWithDescendants(child), own);
  }

  effectiveExp(hash: string): number {
    const m = this.mandateOf(hash);
    const leases = this.leasesOf(hash);
    const rate = leases.reduce((sum, l) => sum + l.hourlyUsd, 0);
    if (rate <= 0) return m.exp;
    const budget = m.limit_usd - this.registry.allocatedTo(hash) - this.registry.settled(hash);
    const weightedStart = leases.reduce((sum, l) => sum + l.hourlyUsd * l.startedAt, 0);
    return Math.min(m.exp, (budget * 3600 + weightedStart) / rate);
  }

  status(hash: string): MandateStatus {
    const m = this.mandateOf(hash);
    const remaining = this.registry.remaining(hash);
    const rate = this.burnRate(hash);
    return {
      mandate: hash,
      jti: m.jti,
      limit_usd: m.limit_usd,
      rate_usd_hr: m.rate_usd_hr,
      allocated_usd: this.registry.allocatedTo(hash),
      consumed_usd: this.registry.settled(hash) + this.accrued(hash, this.now()),
      consumed_with_descendants_usd: this.consumedWithDescendants(hash),
      remaining_usd: remaining,
      burn_usd_hr: rate,
      runtime_left_hr: Math.max(0, remaining) / m.rate_usd_hr,
      exp: m.exp,
      effective_exp: this.effectiveExp(hash),
      leases: this.leasesOf(hash).map((l) => l.handle),
    };
  }

  async provision(hash: string, spec: Spec): Promise<ProvisionResult> {
    const now = this.now();
    const verified = this.registry.get(hash);
    if (!verified) return this.refuse(hash, spec, "CHAIN_BROKEN", `mandate ${hash} is not admitted`);
    const m = verified.mandate;

    if (!m.scope.includes(PROVISION_SCOPE)) {
      return this.refuse(hash, spec, "SCOPE_ESCALATION", `scope lacks ${PROVISION_SCOPE}`);
    }
    if (now < m.nbf) return this.refuse(hash, spec, "WINDOW_EXPIRED", `now ${now} before nbf ${m.nbf}`);
    if (now >= this.effectiveExp(hash)) {
      return this.refuse(hash, spec, "WINDOW_EXPIRED", `now ${now} at or after effective_exp ${this.effectiveExp(hash)}`);
    }

    let hourly: number;
    try {
      hourly = await this.resource.quote(spec);
    } catch (error) {
      return this.providerFailure(hash, spec, error);
    }
    if (hourly > m.rate_usd_hr + EPSILON) {
      return this.refuse(hash, spec, "RATE_CEILING_EXCEEDED", `plan ${hourly.toFixed(2)}/hr > mandate rate ${m.rate_usd_hr.toFixed(2)}/hr`);
    }
    const burning = this.burnRate(hash);
    if (burning + hourly > m.rate_usd_hr + EPSILON) {
      return this.refuse(
        hash,
        spec,
        "RATE_CEILING_EXCEEDED",
        `running ${burning.toFixed(2)}/hr + plan ${hourly.toFixed(2)}/hr > mandate rate ${m.rate_usd_hr.toFixed(2)}/hr`,
      );
    }
    const remaining = this.registry.remaining(hash);
    if (remaining <= EPSILON) {
      return this.refuse(hash, spec, "BUDGET_EXCEEDED", `remaining ${remaining.toFixed(2)} <= 0`);
    }

    let handle: string;
    try {
      handle = await this.resource.provision(spec);
    } catch (error) {
      return this.providerFailure(hash, spec, error);
    }
    const lease: Lease = { handle, mandate: hash, spec, hourlyUsd: hourly, startedAt: now };
    this.leases.set(handle, lease);
    this.emit({
      type: "RESOURCE_PROVISIONED",
      at: now,
      mandate: hash,
      handle,
      plan: spec.plan,
      hourly_usd: hourly,
      effective_exp: this.effectiveExp(hash),
    });
    this.rearm();
    return { ok: true, lease };
  }

  async release(handle: string): Promise<number> {
    const lease = this.leases.get(handle);
    if (!lease) throw new Error(`unknown lease ${handle}`);
    const charged = await this.close(lease, this.now());
    this.emit({ type: "RESOURCE_RELEASED", at: this.now(), mandate: lease.mandate, handle, charged_usd: charged });
    this.rearm();
    return charged;
  }

  nextDeadline(): number | null {
    const mandates = new Set([...this.leases.values()].map((l) => l.mandate));
    let next: number | null = null;
    for (const hash of mandates) {
      const exp = this.effectiveExp(hash);
      if (next === null || exp < next) next = exp;
    }
    return next;
  }

  async reap(): Promise<BurnEvent[]> {
    const now = this.now();
    const reaped: BurnEvent[] = [];
    const mandates = new Set([...this.leases.values()].map((l) => l.mandate));
    for (const hash of mandates) {
      const deadline = this.effectiveExp(hash);
      if (now < deadline) continue;
      const m = this.mandateOf(hash);
      const reason: ReapReason = deadline >= m.exp ? "MANDATE_EXPIRED" : "BUDGET_EXHAUSTED";
      for (const lease of this.leasesOf(hash)) {
        const charged = await this.close(lease, deadline);
        const event: BurnEvent = { type: "RESOURCE_REAPED", at: deadline, mandate: hash, handle: lease.handle, reason, charged_usd: charged };
        this.emit(event);
        reaped.push(event);
      }
    }
    this.rearm();
    return reaped;
  }

  startReaper(): void {
    this.rearm(true);
  }

  stopReaper(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private rearm(start = false): void {
    if (!start && this.timer === null) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const deadline = this.nextDeadline();
    const delayMs = deadline === null ? 60_000 : Math.max(0, (deadline - this.now()) * 1000);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reap().finally(() => {
        if (this.timer === null) this.rearm(true);
      });
    }, Math.min(delayMs, 60_000));
  }

  private async close(lease: Lease, at: number): Promise<number> {
    const charged = (lease.hourlyUsd * Math.max(0, at - lease.startedAt)) / 3600;
    this.leases.delete(lease.handle);
    this.registry.recordConsumption(lease.mandate, charged);
    await this.resource.destroy(lease.handle);
    return charged;
  }

  private mandateOf(hash: string) {
    const verified = this.registry.get(hash);
    if (!verified) throw new Error(`unknown mandate ${hash}`);
    return verified.mandate;
  }

  private refuse(hash: string, spec: Spec, code: RefusalCode, detail: string): ProvisionResult {
    this.emit({ type: "PROVISION_REFUSED", at: this.now(), mandate: hash, plan: spec.plan, code, detail });
    return { ok: false, refusal: { code, detail } };
  }

  private providerFailure(hash: string, spec: Spec, error: unknown): ProvisionResult {
    if (!(error instanceof Error)) throw error;
    this.emit({ type: "PROVISION_FAILED", at: this.now(), mandate: hash, plan: spec.plan, code: "PROVIDER_ERROR", detail: error.message });
    return { ok: false, refusal: { code: "PROVIDER_ERROR", detail: error.message } };
  }

  private emit(event: BurnEvent): void {
    this.onEvent?.(event);
  }
}
