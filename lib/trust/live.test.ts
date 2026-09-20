import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { History, VerdictRecord } from "../anchor";
import type { Verdict } from "../auditor";
import { behaviorObservation, TrustIndexClient } from "./index";

const BIN = join(process.cwd(), "agent-trust-discovery", "bin", "agent-trust-discovery");
const CONFIG = join(process.cwd(), "config", "trust-index", "runtime.yaml");
const DB = "/tmp/burn402-trust-index.db";
const BASE = "http://localhost:8090";
const live = process.env.BURN402_LIVE_TRUST === "1" && existsSync(BIN);

describe.runIf(live)("live Trust Index", () => {
  let server: ChildProcess;

  beforeAll(async () => {
    rmSync(DB, { force: true });
    server = spawn(BIN, ["-config", CONFIG], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      if (await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("trust index did not start");
  });

  afterAll(() => {
    server?.kill();
  });

  it("behavior moves from 0 to an evidence-backed score after an anchored breach", async () => {
    const ti = new TrustIndexClient({ baseUrl: BASE });
    const stamp = "2026-09-19T13:00:00Z";
    await ti.importAgents([
      {
        agentId: "live-rogue",
        dnsName: "rogue.burn402.xyz",
        displayName: "rogue.burn402.xyz",
        description: "burn402 live check",
        providerId: "burn402",
        status: "ACTIVE",
        protocols: ["MCP"],
        transports: ["SSE"],
        tags: ["burn402"],
        capabilities: [],
        firstSeen: stamp,
        lastUpdated: stamp,
      },
    ]);
    expect((await ti.evaluation("live-rogue")).trustVector.behavior).toBe(0);

    const history: History = {
      fqdn: "rogue.burn402.xyz",
      rejected: [],
      entries: [{ id: "arweave-tx-id", auditorKey: "k", record: {} as VerdictRecord, verdict: { verdict: "BREACH", failure_mode: "RATE_CEILING_EXCEEDED", iss: "ans://v1.0.0.auditor.burn402.xyz", issued_at: 1 } as Verdict }],
    };
    await ti.importObservations([behaviorObservation("live-rogue", history, "https://ar-io.dev", new Date(stamp))]);

    const after = await ti.evaluation("live-rogue");
    expect(after.trustVector.behavior).toBe(50);
    expect(after.riskFactors).toEqual(expect.arrayContaining(["BEHAVIOR_BURN402_RATE_CEILING_EXCEEDED", "BEHAVIOR_BURN402_SCORE_LOW"]));
    const signal = after.dimensions.find((d) => d.dimension === "behavior")!.signalScores[0];
    expect(signal).toMatchObject({ signalId: "burn402.behavior.score", rawScore: 50 });
  });
});
