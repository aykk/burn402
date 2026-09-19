import { MandateError } from "./errors";
import { verifyMandate, type KeyResolver, type VerifiedMandate } from "./jws";

export type RefusalCode =
  | "SCOPE_ESCALATION"
  | "BUDGET_EXCEEDED"
  | "RATE_CEILING_EXCEEDED"
  | "WINDOW_EXPIRED"
  | "DEPTH_EXCEEDED"
  | "CHAIN_BROKEN"
  | "SIGNATURE_INVALID"
  | "IDENTITY_UNANCHORED";

export type Refusal = {
  rule: number;
  code: RefusalCode;
  detail: string;
};

export type DelegationRefused = {
  type: "DELEGATION_REFUSED";
  at: number;
  child_jti: string | null;
  parent: string | null;
  rule: number;
  code: RefusalCode;
  detail: string;
};

export type DelegationAccepted = {
  type: "DELEGATION_ACCEPTED";
  at: number;
  child_jti: string;
  hash: string;
  parent: string | null;
  depth: number;
  limit_usd: number;
  parent_remaining_usd: number | null;
};

export type DelegationEvent = DelegationRefused | DelegationAccepted;

export type AnchorCheck = (iss: string) => Promise<boolean>;

export type RegistryOptions = {
  resolveAgentKeys: KeyResolver;
  resolveRootKeys: KeyResolver;
  isAnchored: AnchorCheck;
  onEvent?: (event: DelegationEvent) => void;
  now?: () => number;
};

export type AdmitResult = { ok: true; mandate: VerifiedMandate } | { ok: false; refusal: Refusal };

const CENT = 1e-9;

function usd(n: number): string {
  return n.toFixed(2);
}

export function checkAttenuation(parent: VerifiedMandate, child: VerifiedMandate, parentRemainingUsd: number): Refusal | null {
  const P = parent.mandate;
  const C = child.mandate;

  const escalated = C.scope.filter((s) => !P.scope.includes(s));
  if (escalated.length > 0) {
    return { rule: 1, code: "SCOPE_ESCALATION", detail: `scope ${escalated.join(", ")} not held by parent` };
  }
  if (C.limit_usd > parentRemainingUsd + CENT) {
    return {
      rule: 2,
      code: "BUDGET_EXCEEDED",
      detail: `limit ${usd(C.limit_usd)} > parent remaining ${usd(parentRemainingUsd)}`,
    };
  }
  if (C.rate_usd_hr > P.rate_usd_hr + CENT) {
    return {
      rule: 3,
      code: "RATE_CEILING_EXCEEDED",
      detail: `rate ${usd(C.rate_usd_hr)}/hr > parent rate ${usd(P.rate_usd_hr)}/hr`,
    };
  }
  if (C.exp > P.exp) {
    return { rule: 4, code: "WINDOW_EXPIRED", detail: `exp ${C.exp} after parent exp ${P.exp}` };
  }
  if (C.nbf < P.nbf) {
    return { rule: 5, code: "WINDOW_EXPIRED", detail: `nbf ${C.nbf} before parent nbf ${P.nbf}` };
  }
  if (C.depth !== P.depth + 1) {
    return { rule: 6, code: "CHAIN_BROKEN", detail: `depth ${C.depth} != parent depth ${P.depth} + 1` };
  }
  if (C.depth >= P.max_depth) {
    return { rule: 7, code: "DEPTH_EXCEEDED", detail: `depth ${C.depth} >= parent max_depth ${P.max_depth}` };
  }
  if (C.max_depth > P.max_depth) {
    return { rule: 8, code: "DEPTH_EXCEEDED", detail: `max_depth ${C.max_depth} > parent max_depth ${P.max_depth}` };
  }
  if (C.iss !== P.sub) {
    return { rule: 9, code: "CHAIN_BROKEN", detail: `iss ${C.iss} != parent sub ${P.sub}` };
  }
  if (C.parent !== parent.hash) {
    return { rule: 10, code: "CHAIN_BROKEN", detail: `parent ${C.parent} != sha256(parent) ${parent.hash}` };
  }
  return null;
}

const SIGNATURE_ERRORS = new Set(["SIGNATURE_INVALID", "UNKNOWN_KEY", "UNSUPPORTED_ALG", "FORBIDDEN_HEADER"]);

function refusalFromError(error: unknown): Refusal {
  if (!(error instanceof MandateError)) throw error;
  if (SIGNATURE_ERRORS.has(error.code)) return { rule: 11, code: "SIGNATURE_INVALID", detail: error.message };
  return { rule: 0, code: "CHAIN_BROKEN", detail: error.message };
}

function peekJti(input: unknown): string | null {
  try {
    const payload = (input as { payload?: unknown }).payload;
    if (typeof payload !== "string") return null;
    const jti = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).jti;
    return typeof jti === "string" ? jti : null;
  } catch {
    return null;
  }
}

export class MandateRegistry {
  private readonly mandates = new Map<string, VerifiedMandate>();
  private readonly allocated = new Map<string, number>();
  private readonly consumed = new Map<string, number>();
  private readonly children = new Map<string, string[]>();
  private readonly options: RegistryOptions;
  private pendingSpend: (hash: string) => number = () => 0;

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  attachMeter(pendingSpend: (hash: string) => number): void {
    this.pendingSpend = pendingSpend;
  }

  get(hash: string): VerifiedMandate | undefined {
    return this.mandates.get(hash);
  }

  remaining(hash: string): number {
    const m = this.mandates.get(hash);
    if (!m) throw new Error(`unknown mandate ${hash}`);
    return m.mandate.limit_usd - this.allocatedTo(hash) - this.settled(hash) - this.pendingSpend(hash);
  }

  allocatedTo(hash: string): number {
    return this.allocated.get(hash) ?? 0;
  }

  settled(hash: string): number {
    return this.consumed.get(hash) ?? 0;
  }

  childrenOf(hash: string): string[] {
    return [...(this.children.get(hash) ?? [])];
  }

  recordConsumption(hash: string, amountUsd: number): void {
    if (!this.mandates.has(hash)) throw new Error(`unknown mandate ${hash}`);
    this.consumed.set(hash, (this.consumed.get(hash) ?? 0) + amountUsd);
  }

  async admitRoot(input: unknown): Promise<AdmitResult> {
    let root: VerifiedMandate;
    try {
      root = await verifyMandate(input, this.options.resolveRootKeys);
    } catch (error) {
      return this.refuse(peekJti(input), null, refusalFromError(error));
    }
    if (root.mandate.parent !== null || root.mandate.depth !== 0) {
      return this.refuse(root.mandate.jti, null, { rule: 6, code: "CHAIN_BROKEN", detail: "root must have parent null and depth 0" });
    }
    return this.accept(root, null, null);
  }

  async admit(input: unknown): Promise<AdmitResult> {
    let child: VerifiedMandate;
    try {
      child = await verifyMandate(input, this.options.resolveAgentKeys);
    } catch (error) {
      return this.refuse(peekJti(input), null, refusalFromError(error));
    }
    const C = child.mandate;

    if (this.mandates.has(child.hash)) {
      return this.refuse(C.jti, C.parent, { rule: 10, code: "CHAIN_BROKEN", detail: `mandate ${child.hash} already admitted` });
    }
    const parent = C.parent === null ? undefined : this.mandates.get(C.parent);
    if (!parent) {
      return this.refuse(C.jti, C.parent, { rule: 10, code: "CHAIN_BROKEN", detail: `parent ${C.parent} is not an admitted mandate` });
    }

    const parentRemaining = this.remaining(parent.hash);
    const refusal = checkAttenuation(parent, child, parentRemaining);
    if (refusal) return this.refuse(C.jti, C.parent, refusal);

    if (!(await this.options.isAnchored(C.iss))) {
      return this.refuse(C.jti, C.parent, { rule: 12, code: "IDENTITY_UNANCHORED", detail: `${C.iss} does not chain to a trust anchor` });
    }

    return this.accept(child, parent.hash, parentRemaining);
  }

  private accept(m: VerifiedMandate, parentHash: string | null, parentRemaining: number | null): AdmitResult {
    this.mandates.set(m.hash, m);
    if (parentHash !== null) {
      this.allocated.set(parentHash, (this.allocated.get(parentHash) ?? 0) + m.mandate.limit_usd);
      this.children.set(parentHash, [...(this.children.get(parentHash) ?? []), m.hash]);
    }
    this.options.onEvent?.({
      type: "DELEGATION_ACCEPTED",
      at: this.now(),
      child_jti: m.mandate.jti,
      hash: m.hash,
      parent: parentHash,
      depth: m.mandate.depth,
      limit_usd: m.mandate.limit_usd,
      parent_remaining_usd: parentRemaining,
    });
    return { ok: true, mandate: m };
  }

  private refuse(jti: string | null, parent: string | null, refusal: Refusal): AdmitResult {
    this.options.onEvent?.({ type: "DELEGATION_REFUSED", at: this.now(), child_jti: jti, parent, ...refusal });
    return { ok: false, refusal };
  }

  private now(): number {
    return this.options.now ? this.options.now() : Math.floor(Date.now() / 1000);
  }
}
