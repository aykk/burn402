import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRootKeys } from "@/lib/ans";
import { APP_NAME, CONVERSATION_SCHEMA, SCHEMA, TRANSACTION_SCHEMA, TRANSACTION_TYP, TurboGateway, type Network } from "@/lib/anchor";
import { getRuntime } from "@/lib/demo/session";
import { isOwner } from "@/lib/market/session";
import { clusterOf } from "@/lib/market/record";
import { recordWords } from "@/app/components/record-words";
import { fromCompact, verifyJws } from "@/lib/mandate";
import { DEFAULT_BROKER, verifyAnchoredConversation, verifyAnchoredVerdict } from "@/lib/verify";

export const dynamic = "force-dynamic";

const EXPLORER: { [K in Network]: (id: string) => string | null } = {
  production: (id) => `https://viewblock.io/arweave/tx/${id}`,
  testnet: () => null,
};

type Step = { name: string; ok: boolean; detail: string };

const BREACH_ENGLISH: { [mode: string]: string } = {
  SIGNATURE_INVALID: "used a budget it had not been given",
  CHAIN_BROKEN: "spent against a budget that does not lead back to its owner",
  DEPTH_EXCEEDED: "passed the budget on further than it was allowed to",
  SCOPE_ESCALATION: "spent on something the budget did not cover",
  RATE_CEILING_EXCEEDED: "rented a server costing more per hour than its budget allowed",
  BUDGET_EXCEEDED: "spent more than its budget",
  WINDOW_EXPIRED: "spent after its budget had expired",
  UNSETTLED_USAGE: "ran a server it never paid for",
};

function plainBreach(verdict: string | null | undefined, mode: string | null | undefined): string {
  if (verdict !== "BREACH") return "followed its budget";
  if (!mode) return "broke its budget";
  return BREACH_ENGLISH[mode] ?? mode.replace(/_/g, " ").toLowerCase();
}

function verdictOutcome(verdict: string | null | undefined): Outcome {
  if (verdict === "BREACH") return { label: "broke its budget", tone: "bad" };
  return { label: "no violation found", tone: "good" };
}

function conversationOutcome(ok: boolean, withheld: number): Outcome {
  if (!ok) return { label: "could not be checked", tone: "bad" };
  if (withheld > 0) return { label: "signatures verified, some held back", tone: "warn" };
  return { label: "signatures verified", tone: "good" };
}

function plainConversation(plan: string | null, messages: number, withheld: number): string {
  const agreed = plan ? `agreed on a ${plan} server` : "did not agree on a server";
  const held = withheld > 0 ? `, ${withheld} of them kept private` : "";
  return `negotiated over ${messages} signed message${messages === 1 ? "" : "s"} and ${agreed}${held}`;
}

type Outcome = { label: string; tone: "good" | "bad" | "warn" };

type StoredRecord = {
  id: string;
  schema: string;
  kind: "verdict" | "transaction" | "conversation";
  headline: string;
  rawUrl: string;
  explorerUrl: string | null;
  issuedAt: number | null;
  anchoredAt: number | null;
  subject: string | null;
  reason: string | null;
  outcome: Outcome;
  verified: boolean;
  steps: Step[];
  /** The payment's transaction signature, when the record says a payment was signed and the chain gave one. */
  paymentTx?: string | null;
  /** The Solana cluster of `paymentTx`, when the record says (market purchases); null for older records. */
  paymentCluster?: "devnet" | "mainnet" | null;
};

/**
 * Reading and re-checking every record is slow, and Arweave's gateway is sometimes slower or down. So one
 * answer per network (and agent) is kept and shared by everyone asking: it is served at once while it is
 * under a minute old, and after that it is still served at once while a fresh read runs behind it. A
 * failed read never replaces a good answer; only the very first read makes anyone wait.
 */
const FRESH_MS = 60_000;
const KEEP_MS = 6 * 60 * 60_000;
const MAX_CACHED = 24;
type Answer = { status: number; body: unknown };
type Cached = { good: { at: number; answer: Answer } | null; reading: Promise<Answer> | null; asked: number };
const cache: Map<string, Cached> = ((globalThis as unknown as { __burn402Records?: Map<string, Cached> }).__burn402Records ??= new Map());
const FQDN_RE = /^[a-z0-9:/._-]{1,120}$/i;
const TEST_FIXTURE = /^ans:\/\/v[\d.]+\.rogue-\d+\./;

/** The last good whole-list answer per network is also kept on disk, so a restart during a gateway outage still has a list to show. */
const diskFile = (network: Network) => join(process.cwd(), ".burn402", `records-${network}.json`);

function fromDisk(network: Network): { at: number; answer: Answer } | null {
  try {
    const saved = JSON.parse(readFileSync(diskFile(network), "utf8")) as { at?: unknown; body?: unknown };
    if (typeof saved.at !== "number" || typeof saved.body !== "object" || saved.body === null) return null;
    return { at: saved.at, answer: { status: 200, body: saved.body } };
  } catch {
    return null;
  }
}

function toDisk(network: Network, at: number, body: unknown): void {
  try {
    mkdirSync(join(process.cwd(), ".burn402"), { recursive: true });
    writeFileSync(diskFile(network), JSON.stringify({ at, body }));
  } catch {
    // the list is still served from memory
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const network = (url.searchParams.get("network") === "testnet" ? "testnet" : "production") as Network;
  const asked = url.searchParams.get("fqdn");
  // only the owner may ask for one agent's records: each distinct name is a fresh search on Arweave
  const fqdn = asked !== null && FQDN_RE.test(asked) && isOwner(request) ? asked : null;
  const key = `${network}|${fqdn ?? ""}`;
  const now = Date.now();
  let entry = cache.get(key);
  if (!entry) {
    for (const [k, c] of cache) if (now - c.asked > KEEP_MS) cache.delete(k);
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    entry = { good: fqdn === null ? fromDisk(network) : null, reading: null, asked: now };
    cache.set(key, entry);
  }
  entry.asked = now;
  const held = entry;
  const good = held.good && now - held.good.at < KEEP_MS ? held.good : null;
  if (good && now - good.at < FRESH_MS) return Response.json(good.answer.body);
  held.reading ??= load(network, fqdn)
    .then((answer) => {
      if (answer.status === 200) {
        held.good = { at: Date.now(), answer };
        if (fqdn === null) toDisk(network, held.good.at, answer.body);
      }
      return answer;
    })
    .finally(() => {
      held.reading = null;
    });
  // an older good answer is shown now; the read above replaces it for the next visitor
  if (good) return Response.json(good.answer.body);
  // A failed read is answered with 200 and an `error` field, which the page shows as "couldn't read". A 502
  // or 504 here would be replaced by the tunnel's own error page, and the page would get HTML it cannot read.
  const { body } = await held.reading;
  return Response.json(body);
}

async function load(network: Network, fqdn: string | null): Promise<{ status: number; body: unknown }> {
  const gateway = new TurboGateway({ network });
  const rootKeys = parseRootKeys(readFileSync(join(process.cwd(), "config", "ans", "tl-root-keys.txt"), "utf8"));

  const subjectTag = fqdn ? [{ name: "Subject-FQDN", value: fqdn }] : [];
  const query = [{ name: "App-Name", value: APP_NAME }];

  try {
    const [verdicts, transactions, conversations] = await Promise.all([
      gateway.query([...query, { name: "Schema", value: SCHEMA }, ...subjectTag]),
      gateway.query([...query, { name: "Schema", value: TRANSACTION_SCHEMA }, ...subjectTag]),
      gateway.query([...query, { name: "Schema", value: CONVERSATION_SCHEMA }, ...subjectTag]),
    ]);

    const tagOf = (tags: { name: string; value: string }[], name: string) => tags.find((t) => t.name === name)?.value ?? null;
    const seconds = (value: string | null) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    };

    const checked: StoredRecord[] = await Promise.all([
      ...verdicts.map(async (item): Promise<StoredRecord> => {
        const report = await verifyAnchoredVerdict({ gateway, txid: item.id, tlRootKeys: rootKeys, trustedBrokers: [DEFAULT_BROKER] });
        return {
          id: item.id,
          schema: SCHEMA,
          kind: "verdict",
          headline: plainBreach(report.verdict?.verdict, report.verdict?.failure_mode),
          rawUrl: `${gateway.gatewayUrl}/${item.id}`,
          explorerUrl: EXPLORER[network](item.id),
          issuedAt: report.verdict?.issued_at ?? seconds(tagOf(item.tags, "Issued-At")),
          anchoredAt: item.blockAt,
          subject: report.verdict?.subject ?? tagOf(item.tags, "Subject-ANS"),
          reason: report.verdict?.checks?.find((c) => c.result === "FAIL")?.detail ?? null,
          outcome: verdictOutcome(report.verdict?.verdict),
          verified: report.ok,
          steps: report.steps,
        };
      }),
      ...transactions.map(async (item): Promise<StoredRecord> => {
        const steps: Step[] = [];
        let issuedAt = seconds(tagOf(item.tags, "Issued-At"));
        let subject = tagOf(item.tags, "Subject-FQDN");
        // Until the body is read, the tags alone: outcome and plan.
        const tagWords = recordWords({ outcome: tagOf(item.tags, "Outcome"), plan: tagOf(item.tags, "Plan"), usd: null, tx: null, reason: null });
        let headline = tagWords.headline;
        let outcome: Outcome = { label: tagWords.label, tone: tagWords.tone };
        let reason: string | null = null;
        let paymentTx: string | null = null;
        let paymentCluster: "devnet" | "mainnet" | null = null;
        let verified = false;
        try {
          const body = JSON.parse(new TextDecoder().decode(await gateway.fetchData(item.id))) as {
            transaction?: { at?: number; subject?: string; plan?: string; outcome?: string; usd?: number | null; reason?: string | null; tx?: string | null; cluster?: string };
            jws?: string;
          };
          steps.push({ name: "arweave item", ok: true, detail: `uploaded by ${item.ownerKey}` });
          if (body.transaction) {
            issuedAt = body.transaction.at ? Math.floor(body.transaction.at) : issuedAt;
            subject = body.transaction.subject ?? subject;
            const t = body.transaction;
            // Plain words for every record, older ones included: exact amounts, no codes, no raw JSON.
            const words = recordWords({ outcome: t.outcome ?? null, plan: t.plan ?? null, usd: t.usd, tx: t.tx, reason: t.reason });
            headline = words.headline;
            outcome = { label: words.label, tone: words.tone };
            reason = words.reason;
            paymentTx = typeof t.usd === "number" && typeof t.tx === "string" && t.tx ? t.tx : null;
            paymentCluster = clusterOf(t.cluster);
          }
          steps.push({ name: "transaction record", ok: Boolean(body.jws), detail: body.jws ? "signed record attached" : "no signature attached" });
          if (body.jws) {
            const rt = await getRuntime();
            const checkedJws = await verifyJws(fromCompact(body.jws), (iss) => rt.directory.resolveKeys(iss), TRANSACTION_TYP);
            verified = true;
            steps.push({ name: "signature", ok: true, detail: `signed by ${checkedJws.iss}, key sealed in the ANS transparency log` });
          }
        } catch (error) {
          steps.push({ name: "signature", ok: false, detail: (error as Error).message });
        }
        return {
          id: item.id,
          schema: TRANSACTION_SCHEMA,
          kind: "transaction",
          headline,
          rawUrl: `${gateway.gatewayUrl}/${item.id}`,
          explorerUrl: EXPLORER[network](item.id),
          issuedAt,
          anchoredAt: item.blockAt,
          subject,
          reason,
          outcome,
          verified,
          steps,
          paymentTx,
          paymentCluster,
        };
      }),
      ...conversations.map(async (item): Promise<StoredRecord> => {
        const report = await verifyAnchoredConversation({ gateway, txid: item.id, tlRootKeys: rootKeys });
        const withheld = report.turns.filter((t) => t.state === "withheld").length;
        const messages = report.record?.messages.length ?? Number(tagOf(item.tags, "Message-Count") ?? 0);
        return {
          id: item.id,
          schema: CONVERSATION_SCHEMA,
          kind: "conversation",
          headline: plainConversation(report.record?.agreedPlan ?? tagOf(item.tags, "Plan"), messages, withheld),
          rawUrl: `${gateway.gatewayUrl}/${item.id}`,
          explorerUrl: EXPLORER[network](item.id),
          issuedAt: report.record?.at ? Math.floor(report.record.at) : seconds(tagOf(item.tags, "Issued-At")),
          anchoredAt: item.blockAt,
          subject: report.record?.buyer ?? tagOf(item.tags, "Subject-FQDN"),
          reason: report.problems[0] ?? null,
          outcome: conversationOutcome(report.ok, withheld),
          verified: report.ok,
          steps: report.steps,
        };
      }),
    ]);

    checked.sort((a, b) => (b.issuedAt ?? b.anchoredAt ?? 0) - (a.issuedAt ?? a.anchoredAt ?? 0));
    // The Arweave live test (lib/anchor/live.test.ts) writes a throwaway "no violation" verdict for an agent
    // named rogue-<time> on every run. Only those are left out, and only on testnet: a record is never hidden
    // by name alone, so nothing that says an agent broke a rule, no purchase, and nothing on mainnet can be
    // hidden by picking a name.
    const shown = checked.filter((r) => !(network === "testnet" && r.kind === "verdict" && r.outcome.tone === "good" && TEST_FIXTURE.test(r.subject ?? "")));
    return { status: 200, body: { network, fqdn, gatewayUrl: gateway.gatewayUrl, query, readAt: Date.now(), records: shown } };
  } catch (error) {
    return { status: 502, body: { network, fqdn, error: (error as Error).message } };
  }
}
