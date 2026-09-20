import type { PaymentReceipt } from "../auditor";
import type { Broker, Lease, Spec } from "../burn";
import { mandateHash, MandateError, type KeyResolver, type MandateRegistry, type SigningKey } from "../mandate";
import type { PaymentProcessor } from "./processor";
import { signReceipt, verifyProvisionRequest, type ProvisionRequest, type Receipt } from "./signed";

export type GateEvent =
  | { type: "REQUEST_REJECTED"; at: number; status: number; reason: string }
  | { type: "PAYMENT_REQUIRED"; at: number; mandate: string; plan: string; usd: number }
  | { type: "PAYMENT_REJECTED"; at: number; mandate: string; reason: string }
  | { type: "PAYMENT_SETTLED"; at: number; mandate: string; usd: number; tx: string; handle: string }
  | { type: "SETTLEMENT_FAILED"; at: number; mandate: string; reason: string; destroyed: string }
  | { type: "TRANSACTION"; at: number; record: TransactionRecord };

export type TransactionOutcome = "accepted" | "refused" | "payment rejected" | "failed";

export type TransactionRecord = {
  at: number;
  subject: string;
  mandate: string | null;
  mandateJti: string | null;
  plan: string;
  region: string;
  outcome: TransactionOutcome;
  reason: string | null;
  usd: number | null;
  tx: string | null;
  server: string | null;
};

export type GateOptions = {
  registry: MandateRegistry;
  broker: Broker;
  processor: PaymentProcessor;
  resolveAgentKeys: KeyResolver;
  brokerName: string;
  brokerKey: SigningKey;
  payTo: string;
  resourceUrl: string;
  prepayHours?: number;
  maxSkewSec?: number;
  now?: () => number;
  onEvent?: (event: GateEvent) => void;
  decorateSpec?: (spec: Spec, context: { subject: string; mandateJti: string; limitUsd: number; rateUsdHr: number }) => Spec;
};

type Body = { chain?: unknown; request?: unknown };

export class ProvisionGate {
  readonly receipts: PaymentReceipt[] = [];
  private readonly o: Required<Omit<GateOptions, "onEvent" | "decorateSpec">> & Pick<GateOptions, "onEvent" | "decorateSpec">;
  private readonly seen = new Map<string, number>();

  constructor(options: GateOptions) {
    this.o = { prepayHours: 1, maxSkewSec: 120, now: () => Math.floor(Date.now() / 1000), ...options };
  }

  async handle(request: Request): Promise<Response> {
    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      return this.reject(400, "body must be JSON");
    }
    if (!Array.isArray(body.chain) || body.chain.length === 0 || !body.chain.every((c) => typeof c === "string")) {
      return this.reject(400, "chain must be a non-empty array of compact mandates, root first");
    }
    const chain = body.chain as string[];

    let req: ProvisionRequest;
    try {
      req = await verifyProvisionRequest(body.request, this.o.resolveAgentKeys);
    } catch (error) {
      if (error instanceof MandateError) return this.reject(401, `provision request: ${error.message}`);
      throw error;
    }
    const now = this.o.now();
    if (Math.abs(now - req.iat) > this.o.maxSkewSec) return this.reject(401, `provision request iat ${req.iat} is outside ±${this.o.maxSkewSec}s`);
    const header = request.headers.get("PAYMENT-SIGNATURE") ?? request.headers.get("X-PAYMENT");
    if (header && this.seen.has(req.jti)) return this.reject(401, `provision request ${req.jti} was already used`);

    for (const [i, compact] of chain.entries()) {
      if (this.o.registry.get(mandateHash(compact))) continue;
      const parts = compact.split(".");
      const input = { protected: parts[0], payload: parts[1], signature: parts[2] };
      const result = i === 0 ? await this.o.registry.admitRoot(input) : await this.o.registry.admit(input);
      if (!result.ok) {
        this.transaction({ subject: req.iss, mandate: null, mandateJti: null, plan: req.plan, region: req.region, outcome: "refused", reason: `${result.refusal.code}: ${result.refusal.detail}`, usd: null, tx: null, server: null });
        return this.json(403, { refused: true, stage: "delegation", ...result.refusal });
      }
    }
    const leafHash = mandateHash(chain[chain.length - 1]);
    const leaf = this.o.registry.get(leafHash)!;
    if (req.mandate !== leafHash) return this.reject(401, "provision request is not bound to the presented leaf mandate");
    if (req.iss !== leaf.mandate.sub) return this.reject(401, `request signed by ${req.iss}, but the mandate was issued to ${leaf.mandate.sub}`);

    const spec = { plan: req.plan, region: req.region, label: leaf.mandate.jti };
    const pre = await this.o.broker.precheck(leafHash, spec);
    if (!pre.ok) {
      this.transaction({ subject: req.iss, mandate: leafHash, mandateJti: leaf.mandate.jti, plan: spec.plan, region: spec.region, outcome: "refused", reason: `${pre.refusal.code}: ${pre.refusal.detail}`, usd: null, tx: null, server: null });
      return this.json(403, { refused: true, stage: "provision", ...pre.refusal });
    }

    const usd = pre.hourlyUsd * this.o.prepayHours;
    const requirements = await this.o.processor.requirements(usd);
    if (!header) {
      this.emit({ type: "PAYMENT_REQUIRED", at: now, mandate: leafHash, plan: spec.plan, usd });
      const encoded = await this.o.processor.paymentRequiredHeader(requirements, this.o.resourceUrl, `${spec.plan} in ${spec.region}, ${this.o.prepayHours}h prepaid`);
      return this.json(402, { plan: spec.plan, hourly_usd: pre.hourlyUsd, prepay_hours: this.o.prepayHours, usd }, { "PAYMENT-REQUIRED": encoded });
    }

    let payload;
    try {
      payload = this.o.processor.decode(header);
    } catch {
      return this.paymentRejected(leafHash, "payment header could not be decoded");
    }
    const verified = await this.o.processor.verify(payload, requirements);
    if (!verified.ok) {
      this.transaction({ subject: req.iss, mandate: leafHash, mandateJti: leaf.mandate.jti, plan: spec.plan, region: spec.region, outcome: "payment rejected", reason: verified.reason, usd, tx: null, server: null });
      return this.paymentRejected(leafHash, verified.reason);
    }

    this.seen.set(req.jti, req.iat);
    this.prune(now);

    const finalSpec = this.o.decorateSpec
      ? this.o.decorateSpec(spec, { subject: leaf.mandate.sub, mandateJti: leaf.mandate.jti, limitUsd: leaf.mandate.limit_usd, rateUsdHr: leaf.mandate.rate_usd_hr })
      : spec;
    const provisioned = await this.o.broker.provision(leafHash, finalSpec);
    if (!provisioned.ok) {
      this.transaction({ subject: req.iss, mandate: leafHash, mandateJti: leaf.mandate.jti, plan: spec.plan, region: spec.region, outcome: provisioned.refusal.code === "PROVIDER_ERROR" ? "failed" : "refused", reason: `${provisioned.refusal.code}: ${provisioned.refusal.detail}`, usd, tx: null, server: null });
      return this.json(provisioned.refusal.code === "PROVIDER_ERROR" ? 502 : 403, { refused: true, stage: "provision", ...provisioned.refusal });
    }

    const settlement = await this.o.processor.settle(payload, requirements);
    if (!settlement.ok) {
      await this.o.broker.release(provisioned.lease.handle);
      this.emit({ type: "SETTLEMENT_FAILED", at: now, mandate: leafHash, reason: settlement.reason, destroyed: provisioned.lease.handle });
      this.transaction({ subject: req.iss, mandate: leafHash, mandateJti: leaf.mandate.jti, plan: spec.plan, region: spec.region, outcome: "failed", reason: `settlement failed: ${settlement.reason}; server destroyed`, usd, tx: null, server: provisioned.lease.handle });
      return this.json(402, { error: "settlement failed; the instance was destroyed", reason: settlement.reason }, {
        "PAYMENT-RESPONSE": this.o.processor.responseHeader(settlement, requirements),
      });
    }

    const receipt: Receipt = {
      jti: `r_${settlement.tx.slice(0, 24)}`,
      iss: this.o.brokerName,
      mandate: leafHash,
      mandate_jti: leaf.mandate.jti,
      usd,
      tx: settlement.tx,
      network: settlement.network,
      payer: settlement.payer,
      pay_to: this.o.payTo,
      settled_at: now,
    };
    const sig = await signReceipt(receipt, this.o.brokerKey);
    this.receipts.push({ mandate_jti: receipt.mandate_jti, usd, tx: receipt.tx, sig });
    this.emit({ type: "PAYMENT_SETTLED", at: now, mandate: leafHash, usd, tx: settlement.tx, handle: provisioned.lease.handle });
    this.transaction({ subject: req.iss, mandate: leafHash, mandateJti: leaf.mandate.jti, plan: spec.plan, region: spec.region, outcome: "accepted", reason: null, usd, tx: settlement.tx, server: provisioned.lease.handle });

    return this.json(200, { lease: leaseView(provisioned.lease), receipt: { ...receipt, sig } }, {
      "PAYMENT-RESPONSE": this.o.processor.responseHeader(settlement, requirements),
    });
  }

  private transaction(fields: Omit<TransactionRecord, "at">): void {
    this.emit({ type: "TRANSACTION", at: this.o.now(), record: { at: this.o.now(), ...fields } });
  }

  private prune(now: number): void {
    for (const [jti, iat] of this.seen) if (now - iat > 2 * this.o.maxSkewSec) this.seen.delete(jti);
  }

  private paymentRejected(mandate: string, reason: string): Response {
    this.emit({ type: "PAYMENT_REJECTED", at: this.o.now(), mandate, reason });
    return this.json(402, { error: "payment rejected", reason });
  }

  private reject(status: number, reason: string): Response {
    this.emit({ type: "REQUEST_REJECTED", at: this.o.now(), status, reason });
    return this.json(status, { error: reason });
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  }

  private emit(event: GateEvent): void {
    this.o.onEvent?.(event);
  }
}

function leaseView(lease: Lease) {
  return { handle: lease.handle, mandate: lease.mandate, plan: lease.spec.plan, region: lease.spec.region, hourly_usd: lease.hourlyUsd, started_at: lease.startedAt };
}
