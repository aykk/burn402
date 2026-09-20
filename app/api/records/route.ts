import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRootKeys } from "@/lib/ans";
import { APP_NAME, SCHEMA, TRANSACTION_SCHEMA, TRANSACTION_TYP, TurboGateway, type Network } from "@/lib/anchor";
import { getSession } from "@/lib/demo/session";
import { fromCompact, verifyJws } from "@/lib/mandate";
import { DEFAULT_BROKER, verifyAnchoredVerdict } from "@/lib/verify";

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

function transactionOutcome(outcome: string | null): Outcome {
  if (outcome === "accepted") return { label: "allowed and paid", tone: "good" };
  if (outcome === "refused") return { label: "refused by the broker", tone: "warn" };
  if (outcome === "payment rejected") return { label: "payment rejected", tone: "bad" };
  if (outcome === "failed") return { label: "could not be started", tone: "bad" };
  return { label: outcome ?? "unknown", tone: "warn" };
}

function plainTransaction(outcome: string | null, plan: string | null, usd: number | null | undefined): string {
  const server = plan ? `a ${plan} server` : "a server";
  if (outcome === "accepted") return `paid ${usd !== null && usd !== undefined ? `${usd.toFixed(6)} USDC ` : ""}for ${server}`;
  if (outcome === "refused") return `asked for ${server} and was refused`;
  if (outcome === "payment rejected") return `tried to pay for ${server} and the payment was rejected`;
  if (outcome === "failed") return `paid for ${server} but it could not be started`;
  return `${outcome ?? "asked"} ${server}`;
}

type Outcome = { label: string; tone: "good" | "bad" | "warn" };

type StoredRecord = {
  id: string;
  schema: string;
  kind: "verdict" | "transaction";
  headline: string;
  rawUrl: string;
  explorerUrl: string | null;
  issuedAt: number | null;
  anchoredAt: number | null;
  subject: string | null;
  outcome: Outcome;
  verified: boolean;
  steps: Step[];
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const network = (url.searchParams.get("network") === "testnet" ? "testnet" : "production") as Network;
  const fqdn = url.searchParams.get("fqdn");
  const gateway = new TurboGateway({ network });
  const rootKeys = parseRootKeys(readFileSync(join(process.cwd(), "config", "ans", "tl-root-keys.txt"), "utf8"));

  const subjectTag = fqdn ? [{ name: "Subject-FQDN", value: fqdn }] : [];
  const query = [{ name: "App-Name", value: APP_NAME }];

  try {
    const [verdicts, transactions] = await Promise.all([
      gateway.query([...query, { name: "Schema", value: SCHEMA }, ...subjectTag]),
      gateway.query([...query, { name: "Schema", value: TRANSACTION_SCHEMA }, ...subjectTag]),
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
          outcome: verdictOutcome(report.verdict?.verdict),
          verified: report.ok,
          steps: report.steps,
        };
      }),
      ...transactions.map(async (item): Promise<StoredRecord> => {
        const steps: Step[] = [];
        let issuedAt = seconds(tagOf(item.tags, "Issued-At"));
        let subject = tagOf(item.tags, "Subject-FQDN");
        let headline = plainTransaction(tagOf(item.tags, "Outcome"), tagOf(item.tags, "Plan"), null);
        let outcome = transactionOutcome(tagOf(item.tags, "Outcome"));
        let verified = false;
        try {
          const body = JSON.parse(new TextDecoder().decode(await gateway.fetchData(item.id))) as {
            transaction?: { at?: number; subject?: string; plan?: string; outcome?: string; usd?: number | null };
            jws?: string;
          };
          steps.push({ name: "arweave item", ok: true, detail: `uploaded by ${item.ownerKey}` });
          if (body.transaction) {
            issuedAt = body.transaction.at ? Math.floor(body.transaction.at) : issuedAt;
            subject = body.transaction.subject ?? subject;
            headline = plainTransaction(body.transaction.outcome ?? null, body.transaction.plan ?? null, body.transaction.usd);
            outcome = transactionOutcome(body.transaction.outcome ?? null);
          }
          steps.push({ name: "transaction record", ok: Boolean(body.jws), detail: body.jws ? "signed record attached" : "no signature attached" });
          if (body.jws) {
            const session = await getSession();
            const checkedJws = await verifyJws(fromCompact(body.jws), (iss) => session.rt.directory.resolveKeys(iss), TRANSACTION_TYP);
            verified = true;
            steps.push({ name: "broker signature", ok: true, detail: `signed by ${checkedJws.iss}, key sealed in the ANS transparency log` });
          }
        } catch (error) {
          steps.push({ name: "broker signature", ok: false, detail: (error as Error).message });
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
          outcome,
          verified,
          steps,
        };
      }),
    ]);

    checked.sort((a, b) => (b.issuedAt ?? b.anchoredAt ?? 0) - (a.issuedAt ?? a.anchoredAt ?? 0));
    return Response.json({ network, fqdn, gatewayUrl: gateway.gatewayUrl, query, records: checked });
  } catch (error) {
    return Response.json({ network, fqdn, error: (error as Error).message }, { status: 502 });
  }
}
