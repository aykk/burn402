import { collectAnsProof, type DirectoryEntry, type TlSource } from "../ans";
import { anchorVerdict, type AnchorPolicy, type AnchorResult } from "../anchor";
import { issueVerdict, type Auditor, type EvidenceBundle, type Verdict } from "../auditor";

const ANS = /^ans:\/\//;

function claims(compact: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(compact.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function namesForProof(bundle: EvidenceBundle, auditorName: string): string[] {
  const names = new Set<string>([auditorName, bundle.subject]);
  for (const compact of [...bundle.chain, ...bundle.delegations]) {
    const c = claims(compact);
    for (const v of [c.iss, c.sub]) if (typeof v === "string" && ANS.test(v)) names.add(v);
  }
  for (const r of bundle.receipts) {
    const iss = claims(r.sig).iss;
    if (typeof iss === "string" && ANS.test(iss)) names.add(iss);
  }
  return [...names];
}

export type Published = { verdict: Verdict; anchored: AnchorResult };

export async function publishVerdict(options: {
  auditor: Auditor;
  bundle: EvidenceBundle;
  tl: TlSource;
  entries: Record<string, DirectoryEntry>;
  anchor: AnchorPolicy;
  issuedAt?: number;
}): Promise<Published> {
  const ans = await collectAnsProof(namesForProof(options.bundle, options.auditor.name), options.tl, options.entries);
  const { verdict, jws } = await issueVerdict(options.auditor, options.bundle, options.issuedAt ?? Math.floor(Date.now() / 1000));
  const anchored = await anchorVerdict(options.anchor, jws, { evidence: options.bundle, ans });
  return { verdict, anchored };
}
