import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VultrError, VultrResource } from "./index";

function apiKey(): string | undefined {
  if (process.env.VULTR_API_KEY) return process.env.VULTR_API_KEY;
  const file = join(process.cwd(), ".env.local");
  if (!existsSync(file)) return undefined;
  return /^VULTR_API_KEY=(.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim();
}

const key = apiKey();
const live = process.env.BURN402_LIVE_VULTR === "1" && Boolean(key);

describe.runIf(live)("live Vultr", () => {
  it("provisions, boots, meters and destroys a CPU instance, leaving nothing running", { timeout: 600_000 }, async () => {
    const vultr = new VultrResource({ apiKey: key! });
    const spec = { plan: "vc2-1c-1gb", region: "ewr", label: "burn402-live-check" };
    expect(await vultr.quote(spec)).toBe(0.007);

    const started = Date.now();
    const id = await vultr.provision(spec);
    try {
      const state = await vultr.waitUntilRunning(id, 480);
      expect(state.server).toBe("ok");
      process.stdout.write(`booted in ${((Date.now() - started) / 1000).toFixed(1)}s at ${state.ip}\n`);
      expect(await vultr.consumed(id)).toBeGreaterThan(0);
    } finally {
      await vultr.destroy(id);
    }
    await new Promise((r) => setTimeout(r, 5000));
    expect((await vultr.listTagged()).map((i) => i.id)).not.toContain(id);
  });

  it("reports GPU plans as ACCESS_BLOCKED while Vultr has not enabled them", async () => {
    const vultr = new VultrResource({ apiKey: key! });
    const error = await vultr.provision({ plan: "vcg-a16-2c-8g-2vram", region: "ewr" }).then(
      async (id) => {
        await vultr.destroy(id);
        return null;
      },
      (e: unknown) => e,
    );
    if (error === null) {
      process.stdout.write("GPU access is now enabled on this account\n");
      return;
    }
    expect(error).toBeInstanceOf(VultrError);
    expect((error as VultrError).code).toBe("ACCESS_BLOCKED");
  });
});
