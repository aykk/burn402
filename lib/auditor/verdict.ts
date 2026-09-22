import { createHash } from "node:crypto";
import { signJws, verifyJws, type KeyResolver, type SignedMandate, type SigningKey } from "../mandate";
import { audit, type AuditDeps, type AuditResult, type EvidenceBundle } from "./audit";
import { canonicalJson } from "./canonical";

export const VERDICT_TYP = "verdict+jws";

export type Verdict = AuditResult & {
  jti: string;
  iss: string;
  issued_at: number;
};

export type SignedVerdict = SignedMandate;

export type VerifiedVerdict = {
  verdict: Verdict;
  hash: string;
  compact: string;
};

export class VerdictError extends Error {
  readonly code: "UNTRUSTED_AUDITOR" | "MALFORMED_VERDICT" | "INVALID_SIGNATURE";

  constructor(code: VerdictError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "VerdictError";
    this.code = code;
  }
}

export function verdictJti(auditor: string, evidence: string): string {
  return `v_${createHash("sha256").update(`${auditor}\n${evidence}`, "utf8").digest("hex").slice(0, 24)}`;
}

export type Auditor = {
  name: string;
  key: SigningKey;
  deps: AuditDeps;
};

export async function issueVerdict(
  auditor: Auditor,
  bundle: EvidenceBundle,
  issuedAt: number,
): Promise<{ verdict: Verdict; jws: SignedVerdict }> {
  const result = await audit(bundle, auditor.deps);
  const verdict: Verdict = { jti: verdictJti(auditor.name, result.evidence), iss: auditor.name, ...result, issued_at: issuedAt };
  const jws = await signJws(verdict, auditor.key, VERDICT_TYP);
  return { verdict, jws };
}

function parseVerdict(payload: unknown): Verdict {
  const v = payload as Partial<Verdict> | null;
  const ok =
    v !== null &&
    typeof v === "object" &&
    typeof v.jti === "string" &&
    typeof v.iss === "string" &&
    typeof v.subject === "string" &&
    typeof v.fqdn === "string" &&
    typeof v.evidence === "string" &&
    Array.isArray(v.chain) &&
    Array.isArray(v.checks) &&
    (v.verdict === "BREACH" || v.verdict === "COMPLIANT") &&
    Number.isSafeInteger(v.issued_at);
  if (!ok) throw new VerdictError("MALFORMED_VERDICT", "verdict payload is missing required fields");
  if (v.jti !== verdictJti(v.iss!, v.evidence!)) throw new VerdictError("MALFORMED_VERDICT", "jti does not match auditor and evidence");
  return v as Verdict;
}

export async function verifyVerdict(
  input: unknown,
  resolveAuditorKeys: KeyResolver,
  trustedAuditors: readonly string[],
): Promise<VerifiedVerdict> {
  let verified;
  try {
    verified = await verifyJws(input, resolveAuditorKeys, VERDICT_TYP);
  } catch (error) {
    throw new VerdictError("INVALID_SIGNATURE", (error as Error).message);
  }
  if (!trustedAuditors.includes(verified.iss)) {
    throw new VerdictError("UNTRUSTED_AUDITOR", `${verified.iss} is not a configured trust anchor`);
  }
  return { verdict: parseVerdict(verified.payload), hash: verified.hash, compact: verified.compact };
}

export type Reproduction = {
  reproduced: boolean;
  mismatches: string[];
  reworded: string[];
  recomputed: AuditResult;
};

// a check's detail is prose for a human; what has to reproduce is the outcome
function outcomeOf(checks: AuditResult["checks"]) {
  return checks.map((c) => ({ id: c.id, result: c.result, failure_mode: c.failure_mode ?? null }));
}

export async function reproduce(verdict: Verdict, bundle: EvidenceBundle, deps: AuditDeps): Promise<Reproduction> {
  const recomputed = await audit(bundle, deps);
  const mismatches: string[] = [];
  const fields = ["evidence", "subject", "fqdn", "chain", "verdict", "failure_mode"] as const;
  for (const field of fields) {
    if (canonicalJson(verdict[field]) !== canonicalJson(recomputed[field])) mismatches.push(field);
  }
  if (canonicalJson(outcomeOf(verdict.checks)) !== canonicalJson(outcomeOf(recomputed.checks))) mismatches.push("checks");

  // wording that has drifted since the verdict was signed, which does not
  // change what the audit concluded
  const reworded = verdict.checks
    .filter((c, i) => (c.detail ?? "") !== (recomputed.checks[i]?.detail ?? ""))
    .map((c) => c.id);

  return { reproduced: mismatches.length === 0, mismatches, reworded, recomputed };
}
