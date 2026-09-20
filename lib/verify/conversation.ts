import { proofEntries, ProofTlSource, TransparencyLogDirectory, type AnsProof, type RootKeys } from "../ans";
import { parseConversationRecord, verifyConversation, type ArweaveGateway, type ConversationRecord, type ConversationTurn } from "../anchor";
import { fqdnOf } from "../auditor";
import type { Step } from "./verify";

export type ConversationReport = {
  txid: string;
  ok: boolean;
  steps: Step[];
  record: ConversationRecord | null;
  turns: ConversationTurn[];
  problems: string[];
};

export async function verifyAnchoredConversation(options: {
  gateway: ArweaveGateway;
  txid: string;
  tlRootKeys: RootKeys;
}): Promise<ConversationReport> {
  const steps: Step[] = [];
  const report: ConversationReport = { txid: options.txid, ok: false, steps, record: null, turns: [], problems: [] };
  const step = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    return ok;
  };

  const item = await options.gateway.item(options.txid);
  if (!step("arweave item", item !== null, item ? `owner ${item.ownerKey}` : "not found on the gateway")) return report;

  let parsed: { conversation: ConversationRecord; jws: string; ans?: AnsProof };
  try {
    parsed = parseConversationRecord(await options.gateway.fetchData(options.txid));
  } catch (error) {
    step("conversation record", false, (error as Error).message);
    return report;
  }
  const record = parsed.conversation;
  report.record = record;
  step(
    "conversation record",
    true,
    `${record.messages.length} message(s) between ${record.buyer} and ${record.desk}, disclosure ${record.disclosure}`,
  );

  if (!parsed.ans) {
    step("ans proof", false, "the record carries no ANS proof, so the keys cannot be checked offline");
    return report;
  }
  const directory = new TransparencyLogDirectory({
    source: new ProofTlSource(parsed.ans),
    rootKeys: options.tlRootKeys,
    entries: proofEntries(parsed.ans),
    now: () => Math.floor(record.at),
  });
  step("ans proof", true, `${Object.keys(proofEntries(parsed.ans)).length} identities sealed in the transparency log`);

  const deskKey = (await directory.resolveKeys(record.desk))[0];
  if (!step("arweave owner", item!.ownerKey === deskKey?.x, item!.ownerKey === deskKey?.x ? `uploaded by ${record.desk}` : `uploaded by ${item!.ownerKey}, not by the desk`)) {
    return report;
  }

  let checked: Awaited<ReturnType<typeof verifyConversation>>;
  try {
    checked = await verifyConversation(record, parsed.jws, (iss) => directory.resolveKeys(iss));
  } catch (error) {
    step("record signature", false, (error as Error).message);
    return report;
  }
  step("record signature", true, `signed by ${record.desk}, key sealed in the ANS transparency log`);
  report.turns = checked.turns;
  report.problems = checked.problems;

  const verified = checked.turns.filter((t) => t.state === "verified").length;
  const withheld = checked.turns.filter((t) => t.state === "withheld").length;
  step(
    "message signatures",
    checked.turns.every((t) => t.state !== "broken"),
    withheld > 0 ? `${verified} verified, ${withheld} held back as commitments` : `${verified} verified`,
  );
  step(
    "plan agreed",
    record.agreedPlan === null || !checked.problems.some((p) => p.includes("never named")),
    record.agreedPlan ? `${record.agreedPlan} was named by the desk in this exchange` : "no plan recorded",
  );

  report.ok = steps.every((s) => s.ok);
  return report;
}

export function conversationFqdns(record: ConversationRecord): { buyer: string; desk: string } {
  return { buyer: fqdnOf(record.buyer), desk: fqdnOf(record.desk) };
}
