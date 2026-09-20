import { historyFor } from "../anchor";
import { VultrResource } from "../burn";
import { fqdnOf, type EvidenceBundle, type UsageRecord, type Verdict } from "../auditor";
import { mandateHash, signMandate, toCompact, type Mandate } from "../mandate";
import { syncBehavior } from "../trust";
import { publishVerdict } from "../verify";
import { suggestRequest, type DatasetSource } from "../train";
import { runAgentProgram, runStressTester } from "./agent";
import { currentModel } from "./models";
import { loadActor, type Actor, type Runtime } from "./runtime";
import type { RegisteredAgent } from "./register";
import { TrainingRun, type TrainingRunView } from "./train";

export const HOURLY_CAP = 0.01;
export const AGENT_BUDGET = 0.0006;
export const PRICEY_PLAN = "vc2-2c-4gb";
export const HELPER_NEED = "at least 1 vCPU and 1 GB of RAM";

export const ROOT = "You → your agent";
export const TO_HELPER = "Your agent → helper";
export const TO_TESTER = "Your agent → stress tester";

export type Turn = { kind: "task" | "text" | "tool_call" | "tool_result"; content: string };
export type TrustReading = { behavior: number; profile: string; riskFactors: string[] };

export type AgentRunView = {
  status: "idle" | "running" | "done" | "failed";
  model: string;
  provider: string;
  transcript: Turn[];
  plan: string | null;
  error: string | null;
};

export type StressView = {
  status: "idle" | "running" | "done" | "failed";
  job: { id: string; agent: string; request: string } | null;
  target: { agent: string; budgetUsd: number; rateUsdHr: number; pricePerHour: number; plan: string } | null;
  attempts: { what: string; result: string; ok: boolean; proves: string }[];
  verdict: Verdict | null;
  verdictId: string | null;
  verdictUrl: string | null;
  trustBefore: TrustReading | null;
  trustAfter: TrustReading | null;
  error: string | null;
};

export class DemoSession {
  readonly rt: Runtime;
  busy = false;
  chains: Record<string, string[]> = {};
  hashes: Record<string, string> = {};
  agent: AgentRunView = { status: "idle", model: "", provider: "", transcript: [], plan: null, error: null };
  job: TrainingRun | null = null;
  previous: TrainingRunView | null = null;
  runs: TrainingRun[] = [];
  company: { name: string; ansName: string; keyFile: string } | null = null;
  stress: StressView = { status: "idle", job: null, target: null, attempts: [], verdict: null, verdictId: null, verdictUrl: null, trustBefore: null, trustAfter: null, error: null };
  private direct: string[] = [];

  constructor(rt: Runtime) {
    this.rt = rt;
  }

  jti(name: string): string {
    return `m_${name}_${this.rt.runId}`;
  }

  mandate(overrides: Partial<Mandate> & Pick<Mandate, "jti" | "iss" | "sub">): Mandate {
    const now = Math.floor(Date.now() / 1000);
    return {
      aud: overrides.sub,
      parent: null,
      depth: 0,
      max_depth: 3,
      scope: ["compute:provision"],
      limit_usd: 20,
      rate_usd_hr: HOURLY_CAP,
      nbf: now - 60,
      exp: now + 7200,
      ...overrides,
    };
  }

  private async sign(m: Mandate, by: Actor): Promise<string> {
    return toCompact(await signMandate(m, by));
  }

  private async admit(label: string, compact: string, root = false): Promise<boolean> {
    const [p, pl, sig] = compact.split(".");
    const input = { protected: p, payload: pl, signature: sig };
    const result = root ? await this.rt.registry.admitRoot(input) : await this.rt.registry.admit(input);
    if (result.ok) this.hashes[label] = result.mandate.hash;
    return result.ok;
  }

  private async root(): Promise<string> {
    if (this.chains.root) return this.chains.root[0];
    const { human, ops } = this.rt.actors;
    const root = await this.sign(this.mandate({ jti: this.jti("root"), iss: human.name, sub: ops.name }), human);
    if (!(await this.admit(ROOT, root, true))) throw new Error("your budget was refused");
    this.chains.root = [root];
    return root;
  }

  private async delegate(label: string, to: Actor, key: string): Promise<string[]> {
    if (this.chains[key]) return this.chains[key];
    const root = await this.root();
    const { ops } = this.rt.actors;
    const parent = this.rt.registry.get(mandateHash(root))!.mandate;
    const leaf = await this.sign(
      this.mandate({ jti: this.jti(key), iss: ops.name, sub: to.name, parent: mandateHash(root), depth: 1, limit_usd: AGENT_BUDGET, nbf: parent.nbf, exp: parent.exp }),
      ops,
    );
    if (!(await this.admit(label, leaf))) throw new Error(`the budget for ${label} was refused`);
    this.chains[key] = [root, leaf];
    return this.chains[key];
  }

  async useAgent(agent: RegisteredAgent): Promise<void> {
    this.rt.entries[agent.ansName] = { agentId: agent.agentId, identityId: agent.identityId };
    const actor = await loadActor(this.rt.config.root, agent.name);
    this.rt.actors.company = actor;
    this.company = { name: agent.name, ansName: agent.ansName, keyFile: agent.name };
    this.rt.log.push("step", "ANS", `${agent.ansName} registered and sealed in the transparency log`);
  }

  async startJob(input: {
    request: string;
    dataset: DatasetSource;
    budgetUsd: number;
    rateUsdHr?: number;
    deadlineMinutes?: number;
    preference: number;
  }): Promise<TrainingRunView> {
    if (this.job && !["done", "failed"].includes(this.job.phase)) return this.job.view();
    if (this.job) this.previous = this.job.view();
    const request = input.request.trim() || suggestRequest(input.dataset);
    const run = new TrainingRun(this.rt, request, input.dataset, {
      agent: this.company ?? undefined,
      budgetUsd: input.budgetUsd,
      rateUsdHr: input.rateUsdHr,
      deadlineMinutes: input.deadlineMinutes,
      preference: input.preference,
    });
    this.job = run;
    this.runs = [run, ...this.runs.filter((r) => r.id !== run.id)].slice(0, 6);
    this.rt.pendingBoot.set(run.mandateJti!, (plan, subject) => run.bootScriptFor(plan, subject));
    void run.run().finally(() => this.rt.pendingBoot.delete(run.mandateJti!));
    return run.view();
  }

  jobFor(conv: string): TrainingRun | null {
    return this.runs.find((r) => r.id === conv) ?? (this.job?.id === conv ? this.job : null);
  }

  finished(): TrainingRun[] {
    return this.runs.filter((r) => r.chain.length > 0);
  }

  async runAgent(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.agent = { ...this.agent, status: "running", transcript: [], plan: null, error: null };
    try {
      const choice = currentModel();
      this.agent.model = choice.modelName;
      this.agent.provider = choice.company;
      this.rt.log.push("step", "AGENT", `helper starts: ${choice.modelName} (${choice.company})`);
      const chain = await this.delegate(TO_HELPER, this.rt.actors.helper, "helper");
      const run = await runAgentProgram<{ model: string; provider: string; transcript: Turn[]; rented: { lease?: { plan: string } } | null }>(
        this.rt.config.root,
        "helper.ts",
        {
          brokerBase: new URL(this.rt.gateUrl).origin,
          chain,
          region: this.rt.config.region,
          budgetUsd: AGENT_BUDGET,
          rateUsdHr: HOURLY_CAP,
          need: HELPER_NEED,
          provider: choice.provider,
          model: choice.model,
          modelName: choice.modelName,
          company: choice.company,
          apiKey: choice.apiKey,
          baseUrl: choice.baseUrl,
        },
        300_000,
      );
      if (!run.ok || !run.result) throw new Error(run.error ?? "the helper program failed");
      this.agent.transcript = run.result.transcript;
      this.agent.plan = run.result.rented?.lease?.plan ?? null;
      for (const t of run.result.transcript) this.rt.log.push("info", `HELPER ${t.kind.toUpperCase()}`, t.content.slice(0, 300));
      this.agent.status = "done";
    } catch (error) {
      this.agent.status = "failed";
      this.agent.error = (error as Error).message;
      this.rt.log.push("error", "AGENT", this.agent.error);
    } finally {
      this.busy = false;
    }
  }

  async runStressTest(jobId?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.stress = { ...this.stress, status: "running", job: null, target: null, attempts: [], error: null };
    const log = this.rt.log;
    const attempt = (what: string, result: string, ok: boolean, proves: string) => this.stress.attempts.push({ what, result, ok, proves });
    log.push("step", "STRESS TEST", "a second agent tries to spend against the same budget");
    try {
      const { rt } = this;
      const tester = rt.actors.stresstester;
      const job = (jobId ? this.jobFor(jobId) : null) ?? this.finished()[0] ?? this.job;
      if (!job || job.chain.length === 0) throw new Error("run a job first: the stress test attacks the budget that job used");
      this.stress.job = { id: job.id, agent: job.agent.ansName, request: job.spec.request };
      const budgetUsd = job.brief.budgetUsd;
      const rateUsdHr = job.brief.rateUsdHr;
      const overCap = await this.planAboveCap(rateUsdHr);
      this.stress.target = { agent: job.agent.ansName, budgetUsd, rateUsdHr, pricePerHour: overCap.hourlyUsd, plan: overCap.id };
      const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const reachable = await rt.trust.reachable();
      if (!reachable) throw new Error("the trust index is not running: start it with npm run trust-index, then try again");
      await rt.trust.importAgents(
        Object.entries(rt.entries).map(([ansName, e]) => ({
          agentId: e.agentId,
          dnsName: fqdnOf(ansName),
          displayName: fqdnOf(ansName),
          description: `burn402 agent ${ansName}`,
          providerId: "burn402",
          status: "ACTIVE",
          protocols: ["MCP"],
          transports: ["SSE"],
          tags: ["burn402"],
          capabilities: [],
          firstSeen: stamp,
          lastUpdated: stamp,
        })),
      );
      this.stress.trustBefore = await this.readTrust(tester.name);
      const chain = await this.attackChain(job, tester);

      const pricey = await runStressTester<{ status: number }>(rt.config.root, { command: "rent", brokerUrl: rt.gateUrl, chain, plan: overCap.id, region: rt.config.region });
      attempt(
        `asked the broker for ${overCap.id}, at $${overCap.hourlyUsd.toFixed(3)} an hour`,
        pricey.result?.status === 403 ? `refused: you capped it at $${rateUsdHr}/hour` : `unexpected ${pricey.result?.status}`,
        pricey.result?.status === 403,
        "the hourly cap you set is enforced by the broker, not by the agent",
      );

      const forged = await runStressTester<{ status: number }>(rt.config.root, {
        command: "forge",
        brokerUrl: rt.gateUrl,
        root: chain[0],
        ops: job.agent.ansName,
        plan: "vc2-1c-1gb",
        region: rt.config.region,
      });
      attempt(
        `signed itself a $20 budget in the name of ${job.agent.ansName}`,
        forged.result?.status === 403 ? "refused: the signature does not match the key sealed for that name" : `unexpected ${forged.result?.status}`,
        forged.result?.status === 403,
        "an agent cannot mint itself a bigger budget by claiming someone else's name",
      );

      const direct = await runStressTester<{ handle: string; hourlyUsd: number }>(rt.config.root, {
        command: "rent-direct",
        plan: overCap.id,
        region: rt.config.region,
        mandateJti: `${job.mandateJti}_tester`,
        budget: `${job.mandateJti}_tester, $${budgetUsd} at up to $${rateUsdHr}/hour`,
      });
      if (!direct.ok || !direct.result) throw new Error(`direct rental failed: ${direct.error}`);
      this.direct.push(direct.result.handle);
      await rt.servers.add(direct.result.handle, { rentedBy: "stress tester", how: "directly from Vultr, skipping the broker", plan: overCap.id, region: rt.config.region, hourlyUsd: direct.result.hourlyUsd });
      attempt(
        `went around the broker and rented ${overCap.id} straight from Vultr`,
        "not stopped: the broker never saw this one",
        false,
        "nothing can stop an agent that already holds a provider key, which is why the next step matters",
      );
      log.push("breach", "OUT_OF_BAND", `${direct.result.handle} ${overCap.id} rented without the broker`);

      const now = Math.floor(Date.now() / 1000);
      const usage: UsageRecord[] = [
        { mandate_jti: `${job.mandateJti}_tester`, handle: direct.result.handle, plan: overCap.id, hourly_usd: direct.result.hourlyUsd, started_at: now - 1, ended_at: null },
      ];
      const bundle: EvidenceBundle = { subject: tester.name, chain, delegations: [], usage, receipts: [], observed_at: now + 1 };
      const { verdict, anchored } = await publishVerdict({ auditor: rt.auditor, bundle, tl: rt.tl, entries: rt.entries, anchor: rt.anchor });
      this.stress.verdict = verdict;
      if (anchored.status === "ANCHORED" || anchored.status === "DUPLICATE") {
        this.stress.verdictId = anchored.id;
        this.stress.verdictUrl = `${rt.arweave.gatewayUrl}/${anchored.id}`;
        log.push("anchor", "VERDICT", `${verdict.verdict} ${verdict.failure_mode ?? ""} stored`, { label: `ar://${anchored.id.slice(0, 10)}..`, href: this.stress.verdictUrl });
      }
      attempt(
        "the auditor re-checked the public record",
        `caught it: ${verdict.failure_mode?.replace(/_/g, " ").toLowerCase() ?? "no violation"}`,
        true,
        "going around the broker does not hide the spend, it just moves where it gets caught",
      );

      await syncBehavior({
        trustIndex: rt.trust,
        anchor: rt.anchor,
        gatewayUrl: rt.arweave.gatewayUrl,
        agents: Object.entries(rt.entries).map(([ansName, e]) => ({ agentId: e.agentId, ansName })),
      });
      this.stress.trustAfter = await this.readTrust(tester.name);
      const history = await historyFor(rt.anchor, fqdnOf(tester.name));
      const before = this.stress.trustBefore.behavior;
      const after = this.stress.trustAfter.behavior;
      const direction = after < before ? "lowered" : after > before ? "raised" : "kept";
      attempt(
        `the trust index ${direction} its behaviour score`,
        `${before} → ${after}, from ${history.entries.length} anchored violation(s) on ${fqdnOf(tester.name)}`,
        after <= before,
        "the record follows the agent's domain, so other systems can read it",
      );

      for (const handle of this.direct.splice(0)) {
        await rt.resource.destroy(handle);
        rt.servers.markShutDown(handle, "shut down after the stress test");
        log.push("info", "CLEANUP", `${handle} destroyed`);
      }
      this.stress.status = "done";
    } catch (error) {
      this.stress.status = "failed";
      this.stress.error = (error as Error).message;
      log.push("error", "STRESS TEST", this.stress.error);
    } finally {
      this.busy = false;
    }
  }

  private async planAboveCap(rateUsdHr: number): Promise<{ id: string; hourlyUsd: number }> {
    if (this.rt.resource.kind !== "vultr") return { id: PRICEY_PLAN, hourlyUsd: 0.027 };
    const catalog = await (this.rt.resource as VultrResource).catalog(this.rt.config.region);
    const over = catalog
      .filter((p) => p.hourlyUsd > rateUsdHr && p.ramGb >= 1 && !p.id.endsWith("-v6"))
      .sort((a, b) => a.hourlyUsd - b.hourlyUsd)[0];
    if (!over) throw new Error("every plan is inside your hourly cap, so there is nothing for it to overspend on");
    return { id: over.id, hourlyUsd: over.hourlyUsd };
  }

  private async attackChain(job: TrainingRun, tester: Actor): Promise<string[]> {
    const key = `tester_${job.id}`;
    if (this.chains[key]) return this.chains[key];
    const root = job.chain[0];
    const parent = this.rt.registry.get(mandateHash(root))!.mandate;
    const leaf = await this.sign(
      this.mandate({
        jti: `${job.mandateJti}_tester`,
        iss: job.agent.ansName,
        sub: tester.name,
        parent: mandateHash(root),
        depth: 1,
        max_depth: parent.max_depth,
        scope: parent.scope,
        limit_usd: Math.min(parent.limit_usd, 0.05),
        rate_usd_hr: parent.rate_usd_hr,
        nbf: parent.nbf,
        exp: parent.exp,
      }),
      this.rt.actors.company ?? this.rt.actors.ops,
    );
    if (!(await this.admit(TO_TESTER, leaf))) throw new Error("the budget handed to the stress tester was refused");
    this.chains[key] = [root, leaf];
    return this.chains[key];
  }

  private async readTrust(agentName: string): Promise<TrustReading> {
    const e = await this.rt.trust.evaluation(this.rt.entries[agentName].agentId);
    return { behavior: e.trustVector.behavior ?? 0, profile: e.recommendedProfile, riskFactors: e.riskFactors };
  }
}
