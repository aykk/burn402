import { setDefaultResultOrder } from "node:dns";
import type { Resource, Spec } from "./resource";

export const VULTR_API = "https://api.vultr.com/v2";
export const BURN402_TAG = "burn402";
export const UBUNTU_24_04 = 2284;

export type VultrErrorCode = "PLAN_UNKNOWN" | "PLAN_UNAVAILABLE" | "ACCESS_BLOCKED" | "UNAUTHORIZED" | "PROVIDER_ERROR";

export class VultrError extends Error {
  readonly code: VultrErrorCode;
  readonly status: number | null;

  constructor(code: VultrErrorCode, message: string, status: number | null = null) {
    super(`${code}: ${message}`);
    this.name = "VultrError";
    this.code = code;
    this.status = status;
  }
}

type VultrPlan = {
  id: string;
  type: string;
  hourly_cost: number;
  locations: string[];
  location_cost?: Record<string, { hourly_cost?: number }>;
  gpu_type?: string;
  gpu_vram_gb?: number;
  vcpu_count?: number;
  ram?: number;
  disk?: number;
  monthly_cost?: number;
};

export type PlanInfo = {
  id: string;
  gpu: boolean;
  gpuType: string | null;
  gpuVramGb: number | null;
  vcpus: number | null;
  ramGb: number | null;
  diskGb: number | null;
};

export type CatalogPlan = {
  id: string;
  family: string;
  vcpus: number;
  ramGb: number;
  diskGb: number;
  hourlyUsd: number;
  monthlyUsd: number;
};

type VultrInstance = {
  id: string;
  status: string;
  power_status: string;
  server_status: string;
  main_ip: string;
  date_created: string;
  plan: string;
  region: string;
  tags?: string[];
};

export type VultrOptions = {
  apiKey: string;
  osId?: number;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type InstanceState = {
  id: string;
  status: string;
  power: string;
  server: string;
  ip: string;
  createdAt: number;
};

export class VultrResource implements Resource {
  readonly kind = "vultr";
  private readonly apiKey: string;
  private readonly osId: number;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private plans: Map<string, VultrPlan> | null = null;
  private readonly hourly = new Map<string, number>();

  constructor(options: VultrOptions) {
    if (!options.apiKey) throw new VultrError("UNAUTHORIZED", "VULTR_API_KEY is not set");
    setDefaultResultOrder("ipv4first");
    this.apiKey = options.apiKey;
    this.osId = options.osId ?? UBUNTU_24_04;
    this.apiUrl = (options.apiUrl ?? VULTR_API).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now() / 1000);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async quote(spec: Spec): Promise<number> {
    const plan = (await this.planTable()).get(spec.plan);
    if (!plan) throw new VultrError("PLAN_UNKNOWN", `no Vultr plan ${spec.plan}`);
    if (!plan.locations.includes(spec.region)) {
      throw new VultrError("PLAN_UNAVAILABLE", `${spec.plan} is not available in ${spec.region}`);
    }
    return plan.location_cost?.[spec.region]?.hourly_cost ?? plan.hourly_cost;
  }

  async planInfo(plan: string): Promise<PlanInfo> {
    const p = (await this.planTable()).get(plan);
    if (!p) throw new VultrError("PLAN_UNKNOWN", `no Vultr plan ${plan}`);
    return {
      id: p.id,
      gpu: p.type === "vcg" || Boolean(p.gpu_type),
      gpuType: p.gpu_type ?? null,
      gpuVramGb: p.gpu_vram_gb ?? null,
      vcpus: p.vcpu_count ?? null,
      ramGb: p.ram ? Math.round((p.ram / 1024) * 10) / 10 : null,
      diskGb: p.disk ?? null,
    };
  }

  async catalog(region: string): Promise<CatalogPlan[]> {
    const plans = [...(await this.planTable()).values()];
    return plans
      .filter((p) => p.locations.includes(region) && p.type !== "vcg" && !p.gpu_type && p.vcpu_count && p.ram)
      .map((p) => ({
        id: p.id,
        family: p.type,
        vcpus: p.vcpu_count!,
        ramGb: Math.round((p.ram! / 1024) * 10) / 10,
        diskGb: p.disk ?? 0,
        hourlyUsd: p.location_cost?.[region]?.hourly_cost ?? p.hourly_cost,
        monthlyUsd: p.monthly_cost ?? 0,
      }))
      .sort((a, b) => a.hourlyUsd - b.hourlyUsd);
  }

  async isGpu(plan: string): Promise<boolean> {
    const p = (await this.planTable()).get(plan);
    return p?.type === "vcg" || Boolean(p?.gpu_type);
  }

  async provision(spec: Spec): Promise<string> {
    const hourly = await this.quote(spec);
    const body = {
      region: spec.region,
      plan: spec.plan,
      os_id: this.osId,
      label: spec.label ?? `${BURN402_TAG}-${spec.plan}`,
      tags: [BURN402_TAG],
      ...(spec.userData ? { user_data: Buffer.from(spec.userData).toString("base64") } : {}),
    };
    const { instance } = (await this.request("POST", "/instances", body)) as { instance: VultrInstance };
    this.hourly.set(instance.id, hourly);
    return instance.id;
  }

  async state(handle: string): Promise<InstanceState> {
    const { instance } = (await this.request("GET", `/instances/${encodeURIComponent(handle)}`)) as { instance: VultrInstance };
    return {
      id: instance.id,
      status: instance.status,
      power: instance.power_status,
      server: instance.server_status,
      ip: instance.main_ip,
      createdAt: Date.parse(instance.date_created) / 1000,
    };
  }

  async consumed(handle: string): Promise<number> {
    const s = await this.state(handle);
    const hourly = this.hourly.get(handle);
    if (hourly === undefined) throw new VultrError("PROVIDER_ERROR", `no quoted rate recorded for ${handle}`);
    return (hourly * Math.max(0, this.now() - s.createdAt)) / 3600;
  }

  async destroy(handle: string, attempts = 24, waitMs = 5000): Promise<void> {
    for (let i = 1; ; i++) {
      try {
        await this.request("DELETE", `/instances/${encodeURIComponent(handle)}`);
        return;
      } catch (error) {
        if (error instanceof VultrError && error.status === 404) return;
        const locked = error instanceof VultrError && error.status === 409;
        if (!locked || i >= attempts) throw error;
        await this.sleep(waitMs);
      }
    }
  }

  async waitUntilRunning(handle: string, timeoutSec = 600, pollMs = 5000): Promise<InstanceState> {
    const deadline = this.now() + timeoutSec;
    for (;;) {
      const s = await this.state(handle);
      if (s.status === "active" && s.power === "running" && s.server === "ok") return s;
      if (this.now() >= deadline) throw new VultrError("PROVIDER_ERROR", `${handle} not running after ${timeoutSec}s (${s.status}/${s.power}/${s.server})`);
      await this.sleep(pollMs);
    }
  }

  async listTagged(): Promise<InstanceState[]> {
    const { instances } = (await this.request("GET", `/instances?tag=${BURN402_TAG}&per_page=500`)) as { instances: VultrInstance[] };
    return instances
      .filter((i) => (i.tags ?? []).includes(BURN402_TAG))
      .map((i) => ({
        id: i.id,
        status: i.status,
        power: i.power_status,
        server: i.server_status,
        ip: i.main_ip,
        createdAt: Date.parse(i.date_created) / 1000,
      }));
  }

  async sweep(): Promise<string[]> {
    const destroyed: string[] = [];
    for (const i of await this.listTagged()) {
      await this.destroy(i.id);
      destroyed.push(i.id);
    }
    return destroyed;
  }

  private async planTable(): Promise<Map<string, VultrPlan>> {
    if (!this.plans) {
      const { plans } = (await this.request("GET", "/plans?type=all&per_page=500")) as { plans: VultrPlan[] };
      this.plans = new Map(plans.map((p) => [p.id, p]));
    }
    return this.plans;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response | null = null;
    let networkError = "";
    for (let attempt = 1; attempt <= 3 && response === null; attempt++) {
      try {
        response = await this.fetchImpl(`${this.apiUrl}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        networkError = (error as Error).message;
        const cause = (error as { cause?: { message?: string } }).cause?.message;
        if (cause) networkError = `${networkError} (${cause})`;
        if (attempt < 3) await this.sleep(attempt * 1000);
      }
    }
    if (response === null) throw new VultrError("PROVIDER_ERROR", `${method} ${path}: ${networkError}`);
    const text = await response.text();
    if (response.ok) return text ? JSON.parse(text) : {};

    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {}
    if (response.status === 401 || response.status === 403) {
      throw new VultrError("UNAUTHORIZED", `${method} ${path}: ${message}`, response.status);
    }
    if (/support request for access/i.test(message)) {
      throw new VultrError("ACCESS_BLOCKED", `Vultr has not enabled this product for the account: ${message}`, response.status);
    }
    throw new VultrError("PROVIDER_ERROR", `${method} ${path} -> HTTP ${response.status}: ${message}`, response.status);
  }
}
