import {
  attenuationFindings,
  fromCompact,
  MandateError,
  verifyMandate,
  type AnchorCheck,
  type KeyResolver,
  type Refusal,
  type VerifiedMandate,
} from "../mandate";
import { PROVISION_SCOPE } from "../burn";
import { fqdnOf, sha256Of } from "./canonical";

export type UsageRecord = {
  mandate_jti: string;
  handle: string;
  plan: string;
  hourly_usd: number;
  started_at: number;
  ended_at: number | null;
};

export type PaymentReceipt = {
  mandate_jti: string;
  usd: number;
  tx: string;
  sig: string;
};

export type EvidenceBundle = {
  subject: string;
  chain: string[];
  delegations: string[];
  usage: UsageRecord[];
  receipts: PaymentReceipt[];
  observed_at: number;
};

export type CheckId =
  | "chain_signatures"
  | "identity_anchored"
  | "chain_structure"
  | "scope_subset"
  | "rate_ceiling"
  | "budget_remaining"
  | "time_window"
  | "receipt_settled";

export type FailureMode =
  | "SIGNATURE_INVALID"
  | "CHAIN_BROKEN"
  | "DEPTH_EXCEEDED"
  | "SCOPE_ESCALATION"
  | "RATE_CEILING_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "WINDOW_EXPIRED"
  | "UNSETTLED_USAGE";

export type Check = {
  id: CheckId;
  result: "PASS" | "FAIL" | "SKIP";
  detail?: string;
  failure_mode?: FailureMode;
};

export type AuditResult = {
  subject: string;
  fqdn: string;
  chain: string[];
  evidence: string;
  verdict: "BREACH" | "COMPLIANT";
  checks: Check[];
  failure_mode: FailureMode | null;
};

export type AuditDeps = {
  resolveAgentKeys: KeyResolver;
  resolveRootKeys: KeyResolver;
  isAnchored: AnchorCheck;
  verifyReceipt?: (receipt: PaymentReceipt) => Promise<boolean>;
};

const ORDER: CheckId[] = [
  "chain_signatures",
  "identity_anchored",
  "chain_structure",
  "scope_subset",
  "rate_ceiling",
  "budget_remaining",
  "time_window",
  "receipt_settled",
];

const RULE_TO_CHECK: Record<number, CheckId> = {
  1: "scope_subset",
  2: "budget_remaining",
  3: "rate_ceiling",
  4: "time_window",
  5: "time_window",
  6: "chain_structure",
  7: "chain_structure",
  8: "chain_structure",
  9: "chain_structure",
  10: "chain_structure",
};

const EPSILON = 1e-9;

function usd(n: number): string {
  return n.toFixed(2);
}

type Finding = { check: CheckId; mode: FailureMode; detail: string };

function fromRefusal(r: Refusal): Finding {
  return { check: RULE_TO_CHECK[r.rule], mode: r.code as FailureMode, detail: `rule ${r.rule}: ${r.detail}` };
}

function usageEnd(u: UsageRecord, observedAt: number): number {
  return u.ended_at ?? observedAt;
}

function usageCost(u: UsageRecord, observedAt: number): number {
  return (u.hourly_usd * Math.max(0, usageEnd(u, observedAt) - u.started_at)) / 3600;
}

function peakRate(usage: UsageRecord[], observedAt: number): number {
  const edges = usage.flatMap((u) => [
    { t: u.started_at, d: u.hourly_usd },
    { t: usageEnd(u, observedAt), d: -u.hourly_usd },
  ]);
  edges.sort((a, b) => a.t - b.t || a.d - b.d);
  let current = 0;
  let peak = 0;
  for (const e of edges) {
    current += e.d;
    peak = Math.max(peak, current);
  }
  return peak;
}

async function verifyChain(bundle: EvidenceBundle, deps: AuditDeps): Promise<{ chain: VerifiedMandate[] } | { error: string }> {
  if (bundle.chain.length === 0) return { error: "empty chain" };
  const chain: VerifiedMandate[] = [];
  for (const [i, compact] of bundle.chain.entries()) {
    try {
      const resolver = i === 0 ? deps.resolveRootKeys : deps.resolveAgentKeys;
      chain.push(await verifyMandate(fromCompact(compact), resolver));
    } catch (error) {
      if (error instanceof MandateError) return { error: `chain[${i}]: ${error.message}` };
      throw error;
    }
  }
  return { chain };
}

async function verifiedDelegations(bundle: EvidenceBundle, deps: AuditDeps): Promise<VerifiedMandate[]> {
  const out: VerifiedMandate[] = [];
  for (const compact of bundle.delegations) {
    try {
      out.push(await verifyMandate(fromCompact(compact), deps.resolveAgentKeys));
    } catch (error) {
      if (!(error instanceof MandateError)) throw error;
    }
  }
  return out;
}

export async function audit(bundle: EvidenceBundle, deps: AuditDeps): Promise<AuditResult> {
  const evidence = sha256Of(bundle);
  const fqdn = fqdnOf(bundle.subject);
  const findings: Finding[] = [];

  const verified = await verifyChain(bundle, deps);
  if ("error" in verified) {
    const checks: Check[] = ORDER.map((id) =>
      id === "chain_signatures"
        ? { id, result: "FAIL", detail: verified.error, failure_mode: "SIGNATURE_INVALID" }
        : { id, result: "SKIP", detail: "chain signatures did not verify" },
    );
    return { subject: bundle.subject, fqdn, chain: [], evidence, verdict: "BREACH", checks, failure_mode: "SIGNATURE_INVALID" };
  }
  const chain = verified.chain;
  const root = chain[0];
  const leaf = chain[chain.length - 1];

  for (const m of chain.slice(1)) {
    if (!(await deps.isAnchored(m.mandate.iss))) {
      findings.push({ check: "identity_anchored", mode: "CHAIN_BROKEN", detail: `${m.mandate.iss} does not chain to a trust anchor` });
    }
  }
  if (!(await deps.isAnchored(bundle.subject))) {
    findings.push({ check: "identity_anchored", mode: "CHAIN_BROKEN", detail: `${bundle.subject} does not chain to a trust anchor` });
  }

  if (root.mandate.parent !== null || root.mandate.depth !== 0) {
    findings.push({ check: "chain_structure", mode: "CHAIN_BROKEN", detail: "root must have parent null and depth 0" });
  }
  if (leaf.mandate.sub !== bundle.subject) {
    findings.push({ check: "chain_structure", mode: "CHAIN_BROKEN", detail: `chain ends at ${leaf.mandate.sub}, not ${bundle.subject}` });
  }
  const foreign = bundle.usage.filter((u) => u.mandate_jti !== leaf.mandate.jti);
  if (foreign.length > 0) {
    findings.push({
      check: "chain_structure",
      mode: "CHAIN_BROKEN",
      detail: `usage under ${[...new Set(foreign.map((u) => u.mandate_jti))].join(", ")} not covered by leaf ${leaf.mandate.jti}`,
    });
  }

  const delegations = await verifiedDelegations(bundle, deps);
  const known = new Map<string, VerifiedMandate>();
  for (const m of [...chain, ...delegations]) known.set(m.hash, m);

  for (let i = 1; i < chain.length; i++) {
    for (const r of attenuationFindings(chain[i - 1], chain[i], Infinity)) findings.push(fromRefusal(r));
  }

  for (const parent of chain) {
    const children = [...known.values()].filter((m) => m.mandate.parent === parent.hash);
    const allocated = children.reduce((sum, m) => sum + m.mandate.limit_usd, 0);
    if (allocated > parent.mandate.limit_usd + EPSILON) {
      findings.push({
        check: "budget_remaining",
        mode: "BUDGET_EXCEEDED",
        detail: `rule 2: ${parent.mandate.jti} delegated ${usd(allocated)} across ${children.length} children > limit ${usd(parent.mandate.limit_usd)}`,
      });
    }
  }

  const L = leaf.mandate;
  if (bundle.usage.length > 0 && !L.scope.includes(PROVISION_SCOPE)) {
    findings.push({ check: "scope_subset", mode: "SCOPE_ESCALATION", detail: `provisioned without ${PROVISION_SCOPE} in scope` });
  }

  const own = bundle.usage.filter((u) => u.mandate_jti === L.jti);
  const peak = peakRate(own, bundle.observed_at);
  if (peak > L.rate_usd_hr + EPSILON) {
    findings.push({
      check: "rate_ceiling",
      mode: "RATE_CEILING_EXCEEDED",
      detail: `provisioned ${usd(peak)}/hr against mandate rate ${usd(L.rate_usd_hr)}/hr`,
    });
  }

  const leafChildren = [...known.values()].filter((m) => m.mandate.parent === leaf.hash);
  const leafAllocated = leafChildren.reduce((sum, m) => sum + m.mandate.limit_usd, 0);
  const consumed = own.reduce((sum, u) => sum + usageCost(u, bundle.observed_at), 0);
  if (consumed + leafAllocated > L.limit_usd + EPSILON) {
    findings.push({
      check: "budget_remaining",
      mode: "BUDGET_EXCEEDED",
      detail: `consumed ${usd(consumed)} + delegated ${usd(leafAllocated)} > limit ${usd(L.limit_usd)}`,
    });
  }

  for (const u of own) {
    if (u.started_at < L.nbf) {
      findings.push({ check: "time_window", mode: "WINDOW_EXPIRED", detail: `${u.handle} started ${u.started_at} before nbf ${L.nbf}` });
    }
    const end = usageEnd(u, bundle.observed_at);
    if (end > L.exp) {
      findings.push({ check: "time_window", mode: "WINDOW_EXPIRED", detail: `${u.handle} ran until ${end}, after exp ${L.exp}` });
    }
  }

  if (own.length > 0) {
    const receipts = bundle.receipts.filter((r) => r.mandate_jti === L.jti);
    const valid: PaymentReceipt[] = [];
    for (const r of receipts) {
      if (!(r.usd > 0) || typeof r.tx !== "string" || r.tx.length === 0) continue;
      if (deps.verifyReceipt && !(await deps.verifyReceipt(r))) continue;
      valid.push(r);
    }
    if (valid.length === 0) {
      findings.push({ check: "receipt_settled", mode: "UNSETTLED_USAGE", detail: `no settled receipt for ${L.jti}` });
    }
  }

  const checks: Check[] = ORDER.map((id) => {
    const hits = findings.filter((f) => f.check === id);
    if (hits.length === 0) return { id, result: "PASS" };
    return { id, result: "FAIL", detail: hits.map((h) => h.detail).join("; "), failure_mode: hits[0].mode };
  });
  const firstFail = checks.find((c) => c.result === "FAIL");

  return {
    subject: bundle.subject,
    fqdn,
    chain: chain.map((m) => m.hash),
    evidence,
    verdict: firstFail ? "BREACH" : "COMPLIANT",
    checks,
    failure_mode: firstFail?.failure_mode ?? null,
  };
}
