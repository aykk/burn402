import { describe, expect, it } from "vitest";
import { FakeResource, reconcile, usageFor, type SettledLease } from "./index";

const PRICES = { "vc2-1c-1gb": 0.007, "vhf-8c-32gb": 0.238 };

function resource(): FakeResource {
  return new FakeResource(PRICES, () => 1_700_000_000, "box");
}

describe("provider reconciliation", () => {
  it("finds an instance the broker never issued a receipt for", async () => {
    const r = resource();
    const paid = await r.provision({ plan: "vc2-1c-1gb", region: "ewr" });
    const rogue = await r.provision({ plan: "vhf-8c-32gb", region: "ewr" });
    const settled: SettledLease[] = [{ handle: paid, mandateJti: "m_1", plan: "vc2-1c-1gb", usd: 0.0006, tx: "sig" }];

    const found = await reconcile({ resource: r, settled, observedAt: 1_700_000_060 });
    expect(found.live).toHaveLength(2);
    expect(found.settled).toEqual([paid]);
    expect(found.unattributed.map((i) => i.id)).toEqual([rogue]);
    expect(found.unattributed[0].plan).toBe("vhf-8c-32gb");
  });

  it("does not count a refused or unpaid transaction as a receipt", async () => {
    const r = resource();
    const handle = await r.provision({ plan: "vc2-1c-1gb", region: "ewr" });
    const settled: SettledLease[] = [
      { handle, mandateJti: "m_1", plan: "vc2-1c-1gb", usd: 0.0006, tx: null },
      { handle: "", mandateJti: null, plan: "vc2-1c-1gb", usd: null, tx: null },
    ];

    const found = await reconcile({ resource: r, settled });
    expect(found.unattributed.map((i) => i.id)).toEqual([handle]);
  });

  it("ignores instances that are already destroyed", async () => {
    const r = resource();
    const handle = await r.provision({ plan: "vhf-8c-32gb", region: "ewr" });
    await r.destroy(handle);

    const found = await reconcile({ resource: r, settled: [] });
    expect(found.live).toEqual([]);
    expect(found.unattributed).toEqual([]);
  });

  it("prices the evidence from the provider, not from the caller", async () => {
    const r = resource();
    const rogue = await r.provision({ plan: "vhf-8c-32gb", region: "ewr" });
    const found = await reconcile({ resource: r, settled: [], observedAt: 1_700_000_060 });

    const usage = await usageFor({ resource: r, instances: found.unattributed, mandateJti: "m_1_tester", observedAt: found.observedAt });
    expect(usage).toEqual([
      { mandate_jti: "m_1_tester", handle: rogue, plan: "vhf-8c-32gb", hourly_usd: 0.238, started_at: 1_700_000_000, ended_at: null },
    ]);
  });

  it("refuses to guess when the provider cannot list what it is running", async () => {
    const blind = { kind: "blind", quote: async () => 0, provision: async () => "x", consumed: async () => 0, destroy: async () => {} };
    await expect(reconcile({ resource: blind, settled: [] })).rejects.toThrow("cannot list what it has running");
  });
});
