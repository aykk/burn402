import { describe, expect, it } from "vitest";
import { resetSession, ResetRefusedError } from "./session";

type Holder = { session: Promise<unknown> | null };

describe("resetSession (I2b)", () => {
  it("refuses while the market run is paying or provisioning and drops nothing", async () => {
    // the module keeps its holder on globalThis; it exists once the module is loaded
    const holder = (globalThis as unknown as { __burn402: Holder }).__burn402;
    const saved = holder.session;
    try {
      for (const phase of ["paying", "provisioning"]) {
        let cancelled = 0;
        const market = { view: () => ({ phase, market: "real" }), cancel: () => cancelled++, destroy: async () => {} };
        const session = Promise.resolve({ market });
        holder.session = session;
        await expect(resetSession()).rejects.toThrow(new ResetRefusedError("A payment is in progress. Wait for it to finish before resetting."));
        expect(holder.session).toBe(session);
        expect(cancelled).toBe(0);
      }
    } finally {
      holder.session = saved;
    }
  });
});
