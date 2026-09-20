import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { kidFor, MandateRegistry, signMandate } from "../mandate";
import { Broker, VultrError, VultrResource, type BurnEvent } from "./index";

const plans = readFileSync(join(process.cwd(), "fixtures", "vultr", "plans.json"), "utf8");
const gpuBlocked = readFileSync(join(process.cwd(), "fixtures", "vultr", "gpu-blocked.json"), "utf8");

type Call = { method: string; path: string; body: unknown; auth: string | null };

function fakeVultr(options: { blockGpu?: boolean; createdAt?: string } = {}) {
  const calls: Call[] = [];
  const instances = new Map<string, { plan: string; tags: string[] }>();
  let n = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v2/, "") + url.search;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, auth: new Headers(init?.headers).get("Authorization") });
    const json = (status: number, value: unknown) => new Response(value === null ? null : JSON.stringify(value), { status });

    if (method === "GET" && path.startsWith("/plans")) return new Response(plans, { status: 200 });
    if (method === "POST" && path === "/instances") {
      if (options.blockGpu && String(body.plan).startsWith("vcg-")) return new Response(gpuBlocked, { status: 400 });
      const id = `inst-${++n}`;
      instances.set(id, { plan: body.plan, tags: body.tags });
      return json(202, { instance: { id, status: "pending", power_status: "running", server_status: "none", main_ip: "0.0.0.0", date_created: options.createdAt ?? "2026-09-19T12:00:00+00:00", plan: body.plan, region: body.region, tags: body.tags } });
    }
    const match = /^\/instances\/([^/?]+)$/.exec(path);
    if (match && method === "GET") {
      if (!instances.has(match[1])) return json(404, { error: "Invalid instance-id." });
      return json(200, { instance: { id: match[1], status: "active", power_status: "running", server_status: "ok", main_ip: "64.176.197.124", date_created: options.createdAt ?? "2026-09-19T12:00:00+00:00", plan: instances.get(match[1])!.plan, region: "ewr", tags: instances.get(match[1])!.tags } });
    }
    if (match && method === "DELETE") {
      if (!instances.delete(match[1])) return json(404, { error: "Invalid instance-id." });
      return json(204, null);
    }
    if (method === "GET" && path.startsWith("/instances?")) {
      return json(200, { instances: [...instances].map(([id, i]) => ({ id, status: "active", power_status: "running", server_status: "ok", main_ip: "1.2.3.4", date_created: "2026-09-19T12:00:00+00:00", plan: i.plan, region: "ewr", tags: i.tags })) });
    }
    return json(404, { error: "not found" });
  }) as typeof fetch;
  return { fetchImpl, calls, instances };
}

const T_CREATED = Date.parse("2026-09-19T12:00:00+00:00") / 1000;

async function expectVultr(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(VultrError);
  expect((error as VultrError).code).toBe(code);
}

describe("VultrResource", () => {
  it("quotes real plan prices, CPU and GPU", async () => {
    const v = new VultrResource({ apiKey: "k", fetch: fakeVultr().fetchImpl });
    expect(await v.quote({ plan: "vc2-1c-1gb", region: "ewr" })).toBe(0.007);
    expect(await v.quote({ plan: "vcg-a16-2c-8g-2vram", region: "ewr" })).toBe(0.059);
    expect(await v.isGpu("vcg-a16-2c-8g-2vram")).toBe(true);
    expect(await v.isGpu("vc2-1c-1gb")).toBe(false);
  });

  it("uses the regional price when the region costs more", async () => {
    const v = new VultrResource({ apiKey: "k", fetch: fakeVultr().fetchImpl });
    expect(await v.quote({ plan: "vc2-1c-1gb", region: "sao" })).toBe(0.01);
  });

  it("refuses unknown plans and plans not sold in the region", async () => {
    const v = new VultrResource({ apiKey: "k", fetch: fakeVultr().fetchImpl });
    await expectVultr(v.quote({ plan: "vc9-nope", region: "ewr" }), "PLAN_UNKNOWN");
    await expectVultr(v.quote({ plan: "vcg-l40s-16c-180g-48vram", region: "ewr" }), "PLAN_UNAVAILABLE");
  });

  it("caches the plan table", async () => {
    const f = fakeVultr();
    const v = new VultrResource({ apiKey: "k", fetch: f.fetchImpl });
    await v.quote({ plan: "vc2-1c-1gb", region: "ewr" });
    await v.quote({ plan: "vc2-2c-4gb", region: "ewr" });
    expect(f.calls.filter((c) => c.path.startsWith("/plans"))).toHaveLength(1);
  });

  it("provisions a tagged instance with the bearer key and the chosen OS", async () => {
    const f = fakeVultr();
    const v = new VultrResource({ apiKey: "secret", fetch: f.fetchImpl });
    const id = await v.provision({ plan: "vc2-1c-1gb", region: "ewr", label: "m_7f3a91" });
    const create = f.calls.find((c) => c.method === "POST")!;
    expect(id).toBe("inst-1");
    expect(create.auth).toBe("Bearer secret");
    expect(create.body).toEqual({ region: "ewr", plan: "vc2-1c-1gb", os_id: 2284, label: "m_7f3a91", tags: ["burn402"] });
  });

  it("classifies the real GPU-blocked response as ACCESS_BLOCKED", async () => {
    const v = new VultrResource({ apiKey: "k", fetch: fakeVultr({ blockGpu: true }).fetchImpl });
    await expectVultr(v.provision({ plan: "vcg-a16-2c-8g-2vram", region: "ewr" }), "ACCESS_BLOCKED");
    expect(await v.provision({ plan: "vc2-1c-1gb", region: "ewr" })).toBe("inst-1");
  });

  it("meters consumption from the instance creation time at the quoted rate", async () => {
    const v = new VultrResource({ apiKey: "k", fetch: fakeVultr().fetchImpl, now: () => T_CREATED + 2 * 3600 });
    const id = await v.provision({ plan: "vcg-a16-2c-8g-2vram", region: "ewr" });
    expect(await v.consumed(id)).toBeCloseTo(0.118);
  });

  it("destroy waits out a locked server instead of failing", async () => {
    let calls = 0;
    const base = fakeVultr();
    const locking = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE" && calls++ < 2) return new Response(JSON.stringify({ error: "Server is currently locked" }), { status: 409 });
      return base.fetchImpl(input, init);
    }) as typeof fetch;
    const v = new VultrResource({ apiKey: "k", fetch: locking, sleep: async () => {} });
    const id = await v.provision({ plan: "vc2-1c-1gb", region: "ewr" });
    await v.destroy(id);
    expect(base.instances.size).toBe(0);
    expect(calls).toBe(3);
  });

  it("destroy is idempotent", async () => {
    const f = fakeVultr();
    const v = new VultrResource({ apiKey: "k", fetch: f.fetchImpl });
    const id = await v.provision({ plan: "vc2-1c-1gb", region: "ewr" });
    await v.destroy(id);
    await v.destroy(id);
    expect(f.instances.size).toBe(0);
  });

  it("waits through the real boot sequence until the instance is fully up", async () => {
    const sequence = [
      ["pending", "running", "none"],
      ["active", "stopped", "locked"],
      ["active", "running", "installingbooting"],
      ["active", "running", "ok"],
    ];
    let polls = 0;
    const base = fakeVultr();
    const stepping = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if ((init?.method ?? "GET") === "GET" && /\/instances\/[^/]+$/.test(path)) {
        const [status, power, server] = sequence[Math.min(polls++, sequence.length - 1)];
        return new Response(JSON.stringify({ instance: { id: "inst-1", status, power_status: power, server_status: server, main_ip: "64.176.197.124", date_created: "2026-09-19T12:00:00+00:00", plan: "vc2-1c-1gb", region: "ewr" } }), { status: 200 });
      }
      return base.fetchImpl(input, init);
    }) as typeof fetch;
    const v = new VultrResource({ apiKey: "k", fetch: stepping, sleep: async () => {} });
    const id = await v.provision({ plan: "vc2-1c-1gb", region: "ewr" });
    expect(await v.waitUntilRunning(id)).toMatchObject({ status: "active", power: "running", server: "ok" });
    expect(polls).toBe(4);
  });

  it("gives up waiting after the timeout", async () => {
    let clock = 0;
    const base = fakeVultr();
    const stuck = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET" && /\/instances\/[^/]+$/.test(new URL(String(input)).pathname)) {
        return new Response(JSON.stringify({ instance: { id: "inst-1", status: "pending", power_status: "running", server_status: "none", main_ip: "0.0.0.0", date_created: "2026-09-19T12:00:00+00:00", plan: "vc2-1c-1gb", region: "ewr" } }), { status: 200 });
      }
      return base.fetchImpl(input, init);
    }) as typeof fetch;
    const v = new VultrResource({ apiKey: "k", fetch: stuck, now: () => clock, sleep: async (ms) => { clock += ms / 1000; } });
    await expectVultr(v.waitUntilRunning(await v.provision({ plan: "vc2-1c-1gb", region: "ewr" }), 60), "PROVIDER_ERROR");
  });

  it("waits until the instance is running", async () => {
    const v = new VultrResource({ apiKey: "k", fetch: fakeVultr().fetchImpl, sleep: async () => {} });
    const id = await v.provision({ plan: "vc2-1c-1gb", region: "ewr" });
    expect(await v.waitUntilRunning(id)).toMatchObject({ status: "active", power: "running", server: "ok" });
  });

  it("sweep destroys every burn402-tagged instance", async () => {
    const f = fakeVultr();
    const v = new VultrResource({ apiKey: "k", fetch: f.fetchImpl });
    await v.provision({ plan: "vc2-1c-1gb", region: "ewr" });
    await v.provision({ plan: "vc2-1c-1gb", region: "ewr" });
    expect(await v.sweep()).toHaveLength(2);
    expect(f.instances.size).toBe(0);
  });

  it("reports auth failures distinctly", async () => {
    const v = new VultrResource({ apiKey: "k", fetch: (async () => new Response(JSON.stringify({ error: "Unauthorized IP address" }), { status: 401 })) as typeof fetch });
    await expectVultr(v.quote({ plan: "vc2-1c-1gb", region: "ewr" }), "UNAUTHORIZED");
    expect(() => new VultrResource({ apiKey: "" })).toThrow(VultrError);
  });
});

describe("Broker on Vultr", () => {
  async function setup(blockGpu: boolean) {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const jwk = await exportJWK(publicKey);
    const registry = new MandateRegistry({
      resolveAgentKeys: async () => [],
      resolveRootKeys: async () => [jwk],
      isAnchored: async () => true,
    });
    const now = 1789800000;
    const root = await registry.admitRoot(
      await signMandate(
        {
          jti: "m_root",
          iss: "did:web:alice.burn402.xyz",
          sub: "ans://v1.0.0.broker.burn402.xyz",
          aud: "ans://v1.0.0.broker.burn402.xyz",
          parent: null,
          depth: 0,
          max_depth: 3,
          scope: ["compute:provision"],
          limit_usd: 1,
          rate_usd_hr: 0.06,
          nbf: now - 60,
          exp: now + 86400,
        },
        { privateKey, kid: await kidFor(jwk) },
      ),
    );
    if (!root.ok) throw new Error(root.refusal.detail);
    const events: BurnEvent[] = [];
    const f = fakeVultr({ blockGpu });
    const broker = new Broker({ registry, resource: new VultrResource({ apiKey: "k", fetch: f.fetchImpl }), now: () => now, onEvent: (e) => events.push(e) });
    return { broker, hash: root.mandate.hash, events, f };
  }

  it("a GPU plan within the ceiling is provisioned when Vultr allows it", async () => {
    const { broker, hash, f } = await setup(false);
    expect((await broker.provision(hash, { plan: "vcg-a16-2c-8g-2vram", region: "ewr" })).ok).toBe(true);
    expect(f.instances.size).toBe(1);
  });

  it("a GPU plan above the ceiling is refused before Vultr is ever called", async () => {
    const { broker, hash, f } = await setup(false);
    const r = await broker.provision(hash, { plan: "vcg-a16-2c-16g-4vram", region: "ewr" });
    expect(r).toMatchObject({ ok: false, refusal: { code: "RATE_CEILING_EXCEEDED", detail: "plan 0.12/hr > mandate rate 0.06/hr" } });
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("Vultr blocking GPUs surfaces as PROVISION_FAILED, not a crash, and leaves no lease", async () => {
    const { broker, hash, events } = await setup(true);
    const r = await broker.provision(hash, { plan: "vcg-a16-2c-8g-2vram", region: "ewr" });
    expect(r).toMatchObject({ ok: false, refusal: { code: "PROVIDER_ERROR" } });
    expect(events.at(-1)).toMatchObject({ type: "PROVISION_FAILED", plan: "vcg-a16-2c-8g-2vram" });
    expect(broker.leasesOf(hash)).toHaveLength(0);
    expect(broker.status(hash).remaining_usd).toBeCloseTo(1);
  });

  it("an unknown plan surfaces as PROVISION_FAILED", async () => {
    const { broker, hash, events } = await setup(false);
    expect((await broker.provision(hash, { plan: "vc9-nope", region: "ewr" })).ok).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "PROVISION_FAILED" });
  });

  it("releasing a lease destroys the Vultr instance", async () => {
    const { broker, hash, f } = await setup(false);
    await broker.provision(hash, { plan: "vc2-1c-1gb", region: "ewr" });
    await broker.release(broker.leasesOf(hash)[0].handle);
    expect(f.instances.size).toBe(0);
  });
});
