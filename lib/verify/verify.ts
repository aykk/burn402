import { proofEntries, ProofTlSource, TransparencyLogDirectory, type RootKeys } from "../ans";
import { parseRecord, type ArweaveGateway, type VerdictRecord } from "../anchor";
import { reproduce, sha256Of, verifyVerdict, type Verdict } from "../auditor";
import { fromCompact, verifyMandate } from "../mandate";
import { DEFAULT_AUDITOR, DEFAULT_BROKER, publicAuditDeps, rootKeysFor } from "./policy";

export type Step = { name: string; ok: boolean; detail: string };

export type ChainLink = { depth: number; jti: string; hash: string; iss: string; sub: string; limit_usd: number; rate_usd_hr: number; scope: string[] };

export type VerifyReport = {
  txid: string;
  ok: boolean;
  steps: Step[];
  verdict: Verdict | null;
  chain: ChainLink[];
  mismatches: string[];
};

export type VerifyOptions = {
  gateway: ArweaveGateway;
  txid: string;
  tlRootKeys: RootKeys;
  trustedAuditors?: readonly string[];
  trustedBrokers?: readonly string[];
};

function peekPayload(record: VerdictRecord): Partial<Verdict> {
  try {
    return JSON.parse(Buffer.from(record.verdict.payload, "base64url").toString("utf8")) as Partial<Verdict>;
  } catch {
    return {};
  }
}

export async function verifyAnchoredVerdict(options: VerifyOptions): Promise<VerifyReport> {
  const steps: Step[] = [];
  const report: VerifyReport = { txid: options.txid, ok: false, steps, verdict: null, chain: [], mismatches: [] };
  const step = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    return ok;
  };
  const trustedAuditors = options.trustedAuditors ?? [DEFAULT_AUDITOR];
  const trustedBrokers = options.trustedBrokers ?? [DEFAULT_BROKER];

  const item = await options.gateway.item(options.txid);
  if (!step("arweave item", item !== null, item ? `owner ${item.ownerKey}` : "not found on the gateway")) return report;

  let record: VerdictRecord;
  try {
    record = parseRecord(await options.gateway.fetchData(options.txid));
  } catch (error) {
    step("verdict record", false, (error as Error).message);
    return report;
  }
  step("verdict record", true, record.evidence && record.ans ? "verdict, evidence and ANS proof attached" : "verdict only");
  if (!record.evidence || !record.ans) {
    step("reproducible", false, "the record carries no evidence bundle or ANS proof, so it cannot be re-audited");
    return report;
  }

  const claimed = peekPayload(record);
  const at = Number.isSafeInteger(claimed.issued_at) ? claimed.issued_at! : 0;
  const directory = new TransparencyLogDirectory({
    source: new ProofTlSource(record.ans),
    rootKeys: options.tlRootKeys,
    entries: proofEntries(record.ans),
    now: () => at,
  });

  let verdict: Verdict;
  try {
    verdict = (await verifyVerdict(record.verdict, (iss) => directory.resolveKeys(iss), trustedAuditors)).verdict;
  } catch (error) {
    step("verdict signature", false, (error as Error).message);
    return report;
  }
  report.verdict = verdict;
  const [auditorKey] = await directory.resolveKeys(verdict.iss);
  step("verdict signature", true, `signed by ${verdict.iss}, key sealed in the ANS transparency log`);
  if (!step("arweave owner", item!.ownerKey === auditorKey?.x, item!.ownerKey === auditorKey?.x ? "uploaded by the auditor's ANS key" : `uploaded by ${item!.ownerKey}, not by ${verdict.iss}`)) return report;
  if (!step("evidence hash", sha256Of(record.evidence) === verdict.evidence, verdict.evidence)) return report;

  for (const [i, compact] of record.evidence.chain.entries()) {
    try {
      const m = await verifyMandate(fromCompact(compact), i === 0 ? rootKeysFor : (iss) => directory.resolveKeys(iss));
      report.chain.push({
        depth: m.mandate.depth,
        jti: m.mandate.jti,
        hash: m.hash,
        iss: m.mandate.iss,
        sub: m.mandate.sub,
        limit_usd: m.mandate.limit_usd,
        rate_usd_hr: m.mandate.rate_usd_hr,
        scope: m.mandate.scope,
      });
    } catch (error) {
      report.chain.push({ depth: i, jti: "?", hash: "?", iss: "?", sub: (error as Error).message, limit_usd: 0, rate_usd_hr: 0, scope: [] });
    }
  }

  const reproduction = await reproduce(verdict, record.evidence, publicAuditDeps(directory, trustedBrokers));
  report.mismatches = reproduction.mismatches;
  step(
    "re-audit",
    reproduction.reproduced,
    reproduction.reproduced ? `${verdict.verdict} ${verdict.failure_mode ?? ""} reproduced from public evidence`.trim() : `differs in ${reproduction.mismatches.join(", ")}`,
  );
  report.ok = steps.every((s) => s.ok);
  return report;
}
