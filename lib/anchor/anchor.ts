import type { AnsProof } from "../ans";
import type { KeyResolver } from "../mandate";
import { fqdnOf, sha256Of, verifyVerdict, VerdictError, type EvidenceBundle, type SignedVerdict, type Verdict } from "../auditor";
import type { ArweaveGateway, ArweaveItem, ArweaveTag } from "./arweave";

export const APP_NAME = "burn402";
export const SCHEMA = "verdict-v1";
export const RECORD_SCHEMA = "burn402/verdict-record-v1";
export const MAX_RECORD_BYTES = 100 * 1024;

export type VerdictRecord = {
  schema: typeof RECORD_SCHEMA;
  verdict: SignedVerdict;
  evidence?: EvidenceBundle;
  ans?: AnsProof;
};

export type Attachments = {
  evidence?: EvidenceBundle;
  ans?: AnsProof;
};

export function parseRecord(data: Uint8Array): VerdictRecord {
  const parsed = JSON.parse(new TextDecoder().decode(data)) as Partial<VerdictRecord> & { protected?: unknown };
  if (parsed.schema === RECORD_SCHEMA && parsed.verdict) return parsed as VerdictRecord;
  if (typeof parsed.protected === "string") return { schema: RECORD_SCHEMA, verdict: parsed as unknown as SignedVerdict };
  throw new Error("not a burn402 verdict record");
}

export type AnchorPolicy = {
  gateway: ArweaveGateway;
  resolveAuditorKeys: KeyResolver;
  trustedAuditors: readonly string[];
};

export type AnchorResult =
  | { status: "ANCHORED"; id: string; jti: string; tags: ArweaveTag[] }
  | { status: "DUPLICATE"; id: string; jti: string }
  | { status: "REFUSED"; reason: string };

export type HistoryEntry = {
  id: string;
  verdict: Verdict;
  auditorKey: string;
  record: VerdictRecord;
};

export type RejectedEntry = {
  id: string;
  reason: string;
};

export type History = {
  fqdn: string;
  entries: HistoryEntry[];
  rejected: RejectedEntry[];
};

export function verdictTags(v: Verdict): ArweaveTag[] {
  return [
    { name: "Content-Type", value: "application/json" },
    { name: "App-Name", value: APP_NAME },
    { name: "Schema", value: SCHEMA },
    { name: "Subject-FQDN", value: v.fqdn },
    { name: "Subject-ANS", value: v.subject },
    { name: "Auditor-FQDN", value: fqdnOf(v.iss) },
    { name: "Failure-Mode", value: v.failure_mode ?? "NONE" },
    { name: "Issued-At", value: String(v.issued_at) },
    { name: "Date", value: new Date(v.issued_at * 1000).toISOString() },
    { name: "Verdict-Jti", value: v.jti },
    { name: "Evidence", value: v.evidence },
  ];
}

async function auditorKeyOf(policy: AnchorPolicy, auditor: string): Promise<string | null> {
  const [key] = await policy.resolveAuditorKeys(auditor);
  return key?.x ?? null;
}

export async function anchorVerdict(policy: AnchorPolicy, jws: SignedVerdict, attachments: Attachments = {}): Promise<AnchorResult> {
  let verdict: Verdict;
  try {
    verdict = (await verifyVerdict(jws, policy.resolveAuditorKeys, policy.trustedAuditors)).verdict;
  } catch (error) {
    if (error instanceof VerdictError) return { status: "REFUSED", reason: error.message };
    throw error;
  }
  if (verdict.verdict !== "BREACH") return { status: "REFUSED", reason: "only BREACH verdicts are anchored" };
  if (attachments.evidence && sha256Of(attachments.evidence) !== verdict.evidence) {
    return { status: "REFUSED", reason: "attached evidence does not hash to the verdict's evidence commitment" };
  }
  const record: VerdictRecord = { schema: RECORD_SCHEMA, verdict: jws, ...attachments };
  const data = new TextEncoder().encode(JSON.stringify(record));
  if (data.length > MAX_RECORD_BYTES) return { status: "REFUSED", reason: `record is ${data.length} bytes, over the ${MAX_RECORD_BYTES} byte limit` };

  const auditorKey = await auditorKeyOf(policy, verdict.iss);
  if (!auditorKey) return { status: "REFUSED", reason: `no ANS key resolved for ${verdict.iss}` };
  if (policy.gateway.ownerKey !== auditorKey) {
    return { status: "REFUSED", reason: `anchoring key is not the ANS key of ${verdict.iss}; the record would not be attributable` };
  }
  const existing = await policy.gateway.query([
    { name: "App-Name", value: APP_NAME },
    { name: "Schema", value: SCHEMA },
    { name: "Verdict-Jti", value: verdict.jti },
  ]);
  const prior = existing.find((item) => item.ownerKey === auditorKey);
  if (prior) return { status: "DUPLICATE", id: prior.id, jti: verdict.jti };

  const tags = verdictTags(verdict);
  const { id, ownerKey } = await policy.gateway.upload(data, tags);
  if (ownerKey !== auditorKey) throw new Error(`gateway signed with ${ownerKey}, expected ${auditorKey}`);
  return { status: "ANCHORED", id, jti: verdict.jti, tags };
}

function tag(item: ArweaveItem, name: string): string | undefined {
  return item.tags.find((t) => t.name === name)?.value;
}

export async function historyFor(policy: AnchorPolicy, fqdn: string): Promise<History> {
  const items = await policy.gateway.query([
    { name: "App-Name", value: APP_NAME },
    { name: "Schema", value: SCHEMA },
    { name: "Subject-FQDN", value: fqdn },
  ]);

  const entries: HistoryEntry[] = [];
  const rejected: RejectedEntry[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    let verdict: Verdict;
    let record: VerdictRecord;
    try {
      record = parseRecord(await policy.gateway.fetchData(item.id));
      verdict = (await verifyVerdict(record.verdict, policy.resolveAuditorKeys, policy.trustedAuditors)).verdict;
    } catch (error) {
      rejected.push({ id: item.id, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (verdict.fqdn !== fqdn) {
      rejected.push({ id: item.id, reason: `verdict is about ${verdict.fqdn}, tagged as ${fqdn}` });
      continue;
    }
    if (tag(item, "Verdict-Jti") !== verdict.jti) {
      rejected.push({ id: item.id, reason: "Verdict-Jti tag does not match the signed verdict" });
      continue;
    }
    const auditorKey = await auditorKeyOf(policy, verdict.iss);
    if (item.ownerKey !== auditorKey) {
      rejected.push({ id: item.id, reason: `uploaded by ${item.ownerKey}, not by ${verdict.iss}` });
      continue;
    }
    if (seen.has(verdict.jti)) continue;
    seen.add(verdict.jti);
    entries.push({ id: item.id, verdict, auditorKey: auditorKey!, record });
  }

  entries.sort((a, b) => a.verdict.issued_at - b.verdict.issued_at);
  return { fqdn, entries, rejected };
}
