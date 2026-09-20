import { collectAnsProof } from "../ans";
import { anchorConversation, anchoredMessage, TurboGateway, type Disclosure } from "../anchor";
import { signMandate, toCompact, type Mandate } from "../mandate";
import { foldJobs, jobSpec, trainingBootScript, type Brief, type JobSpec, type Metric, type PlanQuote, type TrainedModel, type TrainingStatus } from "../train";
import type { DatasetSource } from "../train";
import { runAgentProgram } from "./agent";
import { bytesFor } from "./uploads";
import { currentModel } from "./models";
import type { Runtime } from "./runtime";
import { displayName } from "./runtime";

export const MAX_BUDGET_USD = 20;
export const DEFAULT_RATE_DIVISOR = 4;
export const DEFAULT_DEADLINE_MINUTES = 30;

export type A2AMessage = {
  seq: number;
  at: number;
  from: string;
  fromLabel: "company" | "vultr";
  to: string;
  kind: string;
  text: string;
  signed: string;
  jws: string;
  verified: boolean;
};

export type JobPhase = "negotiating" | "paying" | "booting" | "training" | "publishing" | "done" | "failed";

export type AnchoredConversation = {
  id: string | null;
  url: string | null;
  storage: "uploading" | "stored" | "failed";
  storageError: string | null;
  messages: number;
  disclosure: Disclosure;
  withheld: number;
};

export type TrainingRunView = {
  id: string;
  phase: JobPhase;
  request: string;
  kind: JobSpec["kind"];
  dataset: DatasetSource;
  budgetUsd: number;
  rateUsdHr: number;
  deadlineMinutes: number;
  preference: number;
  foldJobs: number;
  model: { name: string; company: string };
  agent: { name: string; ansName: string };
  messages: A2AMessage[];
  conversation: AnchoredConversation | null;
  quotes: PlanQuote[];
  chosen: PlanQuote | null;
  chosenReason: string | null;
  plan: string | null;
  handle: string | null;
  ip: string | null;
  boxUrl: string | null;
  tx: string | null;
  solscan: string | null;
  arweaveUrl: string | null;
  paidUsd: number | null;
  region: string;
  mandateJti: string | null;
  status: TrainingStatus | null;
  modelReady: boolean;
  metrics: Metric[] | null;
  modelBytes: number | null;
  startedAt: number;
  paidAt: number | null;
  liveAt: number | null;
  doneAt: number | null;
  predictedSeconds: number | null;
  actualSeconds: number | null;
  transcript: { kind: string; content: string }[];
  error: string | null;
};

function view(run: TrainingRun): TrainingRunView {
  const paid = run.rt.transactions.find((t) => t.mandateJti === run.mandateJti && t.outcome === "accepted");
  const arweave = paid?.arweaveUrl ?? null;
  return {
    id: run.id,
    phase: run.phase,
    request: run.spec.request,
    kind: run.spec.kind,
    dataset: run.spec.dataset,
    budgetUsd: run.brief.budgetUsd,
    rateUsdHr: run.brief.rateUsdHr,
    deadlineMinutes: run.brief.deadlineMinutes,
    preference: run.brief.preference,
    foldJobs: run.brief.foldJobs,
    model: run.model,
    agent: { name: run.agent.name, ansName: run.agent.ansName },
    messages: run.messages,
    conversation: run.conversation,
    quotes: run.quotes,
    chosen: run.chosen,
    chosenReason: run.chosenReason,
    plan: run.plan,
    handle: run.handle,
    ip: run.ip,
    boxUrl: run.ip ? `http://${run.ip}/` : null,
    tx: paid?.tx ?? run.tx,
    solscan: paid?.solscan ?? (run.tx ? `https://solscan.io/tx/${run.tx}?cluster=devnet` : null),
    arweaveUrl: arweave,
    paidUsd: paid?.usd ?? run.paidUsd,
    region: run.brief.region,
    mandateJti: run.mandateJti,
    status: run.status,
    modelReady: run.trained !== null,
    metrics: run.trained?.metrics ?? null,
    modelBytes: run.modelBytes,
    startedAt: run.startedAt,
    paidAt: run.paidAt,
    liveAt: run.liveAt,
    doneAt: run.doneAt,
    predictedSeconds: run.chosen?.totalSeconds ?? null,
    actualSeconds: run.doneAt ? Math.round(run.doneAt - run.startedAt) : null,
    transcript: run.transcript,
    error: run.error,
  };
}

export class TrainingRun {
  readonly id: string;
  readonly rt: Runtime;
  readonly spec: JobSpec;
  readonly brief: Brief;
  readonly model: { name: string; company: string };
  readonly agent: { name: string; ansName: string; keyFile: string };
  readonly messages: A2AMessage[] = [];
  readonly transcript: { kind: string; content: string }[] = [];
  phase: JobPhase = "negotiating";
  quotes: PlanQuote[] = [];
  chosen: PlanQuote | null = null;
  chosenReason: string | null = null;
  plan: string | null = null;
  handle: string | null = null;
  ip: string | null = null;
  tx: string | null = null;
  paidUsd: number | null = null;
  mandateJti: string | null = null;
  status: TrainingStatus | null = null;
  trained: TrainedModel | null = null;
  modelBytes: number | null = null;
  readonly startedAt = Date.now() / 1000;
  paidAt: number | null = null;
  liveAt: number | null = null;
  doneAt: number | null = null;
  sent = false;
  conversation: AnchoredConversation | null = null;
  chain: string[] = [];
  error: string | null = null;

  constructor(
    rt: Runtime,
    request: string,
    dataset: DatasetSource,
    options: {
      agent?: { name: string; ansName: string; keyFile: string };
      budgetUsd: number;
      rateUsdHr?: number;
      deadlineMinutes?: number;
      preference: number;
    },
  ) {
    this.rt = rt;
    this.id = `job_${Date.now().toString(36)}`;
    this.mandateJti = `m_${this.id}`;
    this.spec = jobSpec(request, dataset);
    const budgetUsd = Math.min(MAX_BUDGET_USD, Math.max(0.05, options.budgetUsd));
    const rateUsdHr = Math.min(budgetUsd, Math.max(0.003, options.rateUsdHr ?? budgetUsd / DEFAULT_RATE_DIVISOR));
    const deadlineMinutes = Math.min(120, Math.max(3, Math.round(options.deadlineMinutes ?? DEFAULT_DEADLINE_MINUTES)));
    const choice = currentModel();
    this.model = { name: choice.modelName, company: choice.company };
    this.agent = options.agent ?? { name: "your agent", ansName: rt.actors.ops.name, keyFile: "ops" };
    this.brief = {
      request,
      kind: this.spec.kind,
      dataset: { name: dataset.name, note: dataset.note, rows: dataset.rows, bytes: dataset.bytes },
      foldJobs: foldJobs(this.spec),
      budgetUsd,
      rateUsdHr: Math.round(rateUsdHr * 1000) / 1000,
      deadlineMinutes,
      preference: Math.min(1, Math.max(0, options.preference)),
      region: rt.config.region,
    };
  }

  view(): TrainingRunView {
    return view(this);
  }

  record(message: Omit<A2AMessage, "seq" | "at">): A2AMessage {
    const entry: A2AMessage = { seq: this.messages.length + 1, at: Date.now() / 1000, ...message };
    this.messages.push(entry);
    this.rt.log.push("step", `A2A ${entry.fromLabel.toUpperCase()}`, entry.text.slice(0, 220));
    return entry;
  }

  private async mandateChain(): Promise<{ chain: string[]; jti: string }> {
    const { human } = this.rt.actors;
    const subject = this.agent.ansName;
    const now = Math.floor(Date.now() / 1000);
    const jti = this.mandateJti!;
    const mandate: Mandate = {
      jti,
      iss: human.name,
      sub: subject,
      aud: subject,
      parent: null,
      depth: 0,
      max_depth: 2,
      scope: ["compute:provision"],
      limit_usd: this.brief.budgetUsd,
      rate_usd_hr: this.brief.rateUsdHr,
      nbf: now - 60,
      exp: now + this.brief.deadlineMinutes * 60,
    };
    const compact = toCompact(await signMandate(mandate, human));
    const [protectedHeader, payload, signature] = compact.split(".");
    const admitted = await this.rt.registry.admitRoot({ protected: protectedHeader, payload, signature });
    if (!admitted.ok) throw new Error("your budget was refused before the job started");
    this.chain = [compact];
    return { chain: [compact], jti };
  }

  bootScriptFor(plan: string, subject: string): string {
    return trainingBootScript({
      spec: this.spec,
      rentedBy: displayName(subject),
      budget: `${this.mandateJti}, $${this.brief.budgetUsd} at up to $${this.brief.rateUsdHr}/hour, expires in ${this.brief.deadlineMinutes} minutes`,
      plan,
      root: this.rt.config.root,
    });
  }

  async run(): Promise<void> {
    try {
      const { chain } = await this.mandateChain();
      const choice = currentModel();
      this.rt.log.push("step", "JOB", `${this.spec.kind} on ${this.spec.dataset.name}, budget $${this.brief.budgetUsd}, ${this.brief.foldJobs} cross-validation jobs`);
      const result = await runAgentProgram<{
        transcript: { kind: string; content: string }[];
        rented: { lease?: { handle?: string; plan?: string } } | null;
        plan: string | null;
      }>(
        this.rt.config.root,
        "company.ts",
        {
          runId: this.id,
          keyFile: this.agent.keyFile,
          brokerBase: new URL(this.rt.gateUrl).origin,
          chain,
          brief: this.brief,
          provider: choice.provider,
          model: choice.model,
          modelName: choice.modelName,
          company: choice.company,
          apiKey: choice.apiKey,
          baseUrl: choice.baseUrl,
        },
        420_000,
      );
      if (!result.ok || !result.result) throw new Error(result.error ?? "your agent stopped before it rented anything");
      this.transcript.push(...result.result.transcript);
      const lease = result.result.rented?.lease;
      if (!lease?.handle) throw new Error("your agent finished without renting a server");
      this.handle = lease.handle;
      this.plan = lease.plan ?? this.plan;
      this.paidAt = Date.now() / 1000;
      this.phase = "booting";
      void this.anchorNegotiation();
      await this.watch();
    } catch (error) {
      this.phase = "failed";
      this.error = (error as Error).message;
      this.rt.log.push("error", "JOB", this.error);
      await this.release();
    }
  }

  private async anchorNegotiation(): Promise<void> {
    const signed = this.messages.filter((m) => m.jws);
    if (signed.length === 0) return;
    const disclosure = this.rt.disclosure;
    const messages = signed.map((m) =>
      anchoredMessage({
        jws: m.jws,
        iss: m.from,
        kind: m.kind,
        at: m.at,
        disclose: disclosure === "full" || m.fromLabel === "vultr" ? "full" : "hash",
      }),
    );
    const withheld = messages.filter((m) => m.disclose === "hash").length;
    this.conversation = { id: null, url: null, storage: "uploading", storageError: null, messages: messages.length, disclosure, withheld };
    try {
      const gateway = new TurboGateway({ network: this.rt.network, privateJwk: this.rt.actors.vultr.privateJwk });
      const ans = await collectAnsProof([this.rt.actors.vultr.name, this.agent.ansName], this.rt.tl, this.rt.entries);
      const { id } = await anchorConversation({
        gateway,
        desk: this.rt.actors.vultr.name,
        deskKey: this.rt.actors.vultr,
        ans,
        record: {
          conv: this.id,
          at: Math.floor(Date.now() / 1000),
          buyer: this.agent.ansName,
          desk: this.rt.actors.vultr.name,
          mandateJti: this.mandateJti,
          agreedPlan: this.plan,
          disclosure,
          messages,
        },
      });
      this.conversation = { id, url: `${gateway.gatewayUrl}/${id}`, storage: "stored", storageError: null, messages: messages.length, disclosure, withheld };
      this.rt.log.push(
        "anchor",
        "ARWEAVE",
        withheld > 0
          ? `the negotiation for ${this.plan} stored, ${withheld} of ${messages.length} messages held back as hashes`
          : `the ${messages.length}-message negotiation for ${this.plan} stored in full`,
        { label: `ar://${id.slice(0, 10)}..`, href: this.conversation.url! },
      );
    } catch (error) {
      const message = (error as Error).message;
      this.conversation = { id: null, url: null, storage: "failed", storageError: message, messages: messages.length, disclosure, withheld };
      this.rt.log.push("error", "ARWEAVE", `could not store the negotiation: ${message}`);
    }
  }

  private async sendDataset(): Promise<void> {
    const bytes = bytesFor(this.spec.dataset);
    if (!bytes) throw new Error("the uploaded file is no longer in memory; add it again and restart the job");
    let last = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(`http://${this.ip}/dataset`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(bytes),
          signal: AbortSignal.timeout(180000),
        });
        if (response.ok) {
          this.sent = true;
          break;
        }
        last = `HTTP ${response.status}`;
      } catch (error) {
        last = (error as Error).message;
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    if (!this.sent) throw new Error(`the box would not take the dataset: ${last}`);
    this.rt.log.push("info", "DATASET", `${Math.round(bytes.length / 1024)} KB of ${this.spec.dataset.name} handed to ${this.handle}`);
  }

  private async watch(): Promise<void> {
    const deadline = Date.now() + 25 * 60 * 1000;
    let served = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const server = this.rt.servers.servers.find((s) => s.handle === this.handle);
      if (server?.ip && server.ip !== this.ip) {
        this.ip = server.ip;
        this.rt.log.push("info", "BOX", `${this.handle} answers on ${this.ip}`);
      }
      if (!this.ip) continue;
      const status = await fetch(`http://${this.ip}/status.json`, { signal: AbortSignal.timeout(4000) })
        .then((r) => (r.ok ? (r.json() as Promise<TrainingStatus>) : null))
        .catch(() => null);
      if (!status) continue;
      if (!served) {
        served = true;
        this.liveAt = Date.now() / 1000;
      }
      if (this.spec.dataset.origin === "upload" && !this.sent) {
        await this.sendDataset();
        continue;
      }
      const before = this.status?.message;
      this.status = status;
      if (status.message && status.message !== before) this.rt.log.push("info", "TRAIN", status.message);
      if (status.phase === "training" && this.phase === "booting") this.phase = "training";
      if (status.error) throw new Error(`training failed on the box: ${status.error}`);
      if (status.done) {
        this.phase = "publishing";
        const model = await fetch(`http://${this.ip}/model.json`, { signal: AbortSignal.timeout(30000) });
        const text = await model.text();
        this.trained = JSON.parse(text) as TrainedModel;
        this.modelBytes = text.length;
        this.doneAt = Date.now() / 1000;
        this.phase = "done";
        this.rt.log.push(
          "provisioned",
          "MODEL",
          `${this.trained.kind} trained on ${this.plan} in ${Math.round(this.doneAt - this.startedAt)}s, model is ${Math.round(this.modelBytes / 1024)} KB`,
        );
        await this.release();
        return;
      }
    }
    throw new Error("the box did not finish inside 25 minutes");
  }

  private async release(): Promise<void> {
    if (!this.handle) return;
    try {
      await this.rt.broker.release(this.handle);
      this.rt.servers.markShutDown(this.handle, "the job finished");
    } catch (error) {
      this.rt.log.push("error", "RELEASE", (error as Error).message);
    }
  }
}
