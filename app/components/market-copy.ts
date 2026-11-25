import { usdExact } from "../../lib/market/money";
import type { MarketRunView, OfferRow } from "@/lib/market/run";
import type { MarketId, Need } from "@/lib/market/types";
import { duration, elapsedText } from "./format";

/** Backend prose is lowercase fragments; shown as a sentence. */
export const sentence = (t: string) => {
  const s = t.trim().charAt(0).toUpperCase() + t.trim().slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
};

/** "1 hour", "3 hours", "1.5 hours", "30 minutes". */
export function hoursText(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return "-";
  // A span a few seconds short of an hour (a destroy time just under it) is still "1 hour", not "60 minutes".
  if (h < 1 && Math.round(h * 60) < 60) {
    const m = Math.max(1, Math.round(h * 60));
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const n = h < 1 ? 1 : parseFloat(h.toFixed(2));
  return `${n} hour${n === 1 ? "" : "s"}`;
}

/** A countdown: "45s", "2m 05s", then "1h 05m" past an hour. */
export function timeLeft(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "-";
  if (seconds < 3600) return duration(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** A wallet address as its first and last four characters: "ELT2…d5Ux". */
export function shortAddress(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/** A Solana transaction signature: base58, about 64 to 90 characters. */
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** A Solscan link only for a tx id of the expected shape; anything else gets no link (null). */
export function solscanUrl(tx: string | null | undefined, market: MarketId): string | null {
  return solscanUrlForCluster(tx, market === "test" ? "devnet" : "mainnet");
}

/** The same link by cluster, for stored records; no link when the cluster is not known. */
export function solscanUrlForCluster(tx: string | null | undefined, cluster: "devnet" | "mainnet" | null | undefined): string | null {
  if (!tx || !SIGNATURE_RE.test(tx) || !cluster) return null;
  return `https://solscan.io/tx/${tx}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

export const MARKET_NAME: Record<MarketId, string> = { test: "Test market (devnet)", real: "Real market (mainnet)" };

/** The exact amount being approved ("$0.010382"), never rounded: the owner approves a specific payment. */
export function approvalSentence(a: NonNullable<MarketRunView["approval"]>): string {
  return `Pay ${a.exact} ${a.token} to ${shortAddress(a.payTo)} on ${a.network} for ${a.plan} in ${a.region}, ${hoursText(a.hours)}.`;
}

/** "Includes the seller's 15% surcharge for rentals under 24 hours.", or null when the quote has none. */
export function surchargeLine(s: NonNullable<MarketRunView["approval"]>["surcharge"]): string | null {
  if (!s) return null;
  return `Includes the seller's ${s.pct}% surcharge for rentals under ${hoursText(s.underHours)}.`;
}

const NETWORK: Record<MarketId, string> = { test: "Solana devnet", real: "Solana mainnet" };

type PaymentFacts = Pick<NonNullable<MarketRunView["payment"]>, "atomic" | "status">;

/** The payment as the meter states it: settled only once confirmed, always the exact amount. */
export function paymentLine(p: PaymentFacts, market: MarketId): string {
  const amount = usdExact(p.atomic);
  return p.status === "confirmed" ? `Paid ${amount} over x402, settled on ${NETWORK[market]}.` : `Sent ${amount} over x402 on ${NETWORK[market]}, not confirmed yet.`;
}

/** After the machine is destroyed: what the prepaid time cost, how long it ran, and that unused time stays paid. */
export function prepaidLine(p: PaymentFacts, hours: number, ranSeconds: number | null): string {
  const amount = usdExact(p.atomic);
  const paid = p.status === "confirmed" ? `Paid ${amount} for ${hoursText(hours)}.` : `Sent ${amount} for ${hoursText(hours)}, not confirmed yet.`;
  const ran = ranSeconds !== null ? ` Destroyed after ${elapsedText(ranSeconds)}.` : "";
  return `${paid}${ran} Unused time is not refunded by this app. Whether the seller refunds it depends on the seller.`;
}

/**
 * Every code the market puts on a left-out plan, a failed quote or a refusal, in words. The one place
 * codes become words: sentences never show a code (it may sit in a title tooltip for debugging).
 */
const LEFT_OUT: Record<string, { row: (need: Pick<Need, "kind">) => string; count: (n: number, need: Pick<Need, "kind">) => string }> = {
  WRONG_KIND: {
    row: (need) => (need.kind === "cpu" ? "GPU, you asked for CPU" : "CPU only, you asked for a GPU"),
    count: (n, need) => `${n} ${need.kind === "cpu" ? "GPU" : "CPU"} plan${n === 1 ? "" : "s"} (you asked for ${need.kind === "cpu" ? "CPU" : "a GPU"})`,
  },
  TOO_SMALL: { row: () => "too small", count: (n) => `${n} too small` },
  OUT_OF_STOCK: { row: () => "out of stock", count: (n) => `${n} out of stock` },
  NO_REGION: { row: () => "not in your regions", count: (n) => `${n} not in your regions` },
  SPOT_NOT_ALLOWED: { row: () => "interruptible", count: (n) => `${n} interruptible (you did not allow that)` },
  NOT_RENTABLE: { row: () => "not for rent", count: (n) => `${n} not for rent by an agent` },
  OVER_RATE: { row: () => "over your hourly limit", count: (n) => `${n} over your hourly limit` },
  OVER_BUDGET: { row: () => "over your budget", count: (n) => `${n} over your budget` },
};

/** Why one plan was left out, for its status cell, read from the row's code. */
export function leftOutPhrase(code: string | null, need: Pick<Need, "kind">): string {
  return (code && LEFT_OUT[code]?.row(need)) || "left out";
}

/** "10 plans left out: 7 too small, 3 GPU plans (you asked for CPU)", or null when none were. */
export function leftOutSummary(leftOut: MarketRunView["leftOut"], need: Pick<Need, "kind">): string | null {
  const total = leftOut.reduce((n, l) => n + l.count, 0);
  if (total === 0) return null;
  const parts = leftOut.map((l) => LEFT_OUT[l.reason]?.count(l.count, need) ?? `${l.count} for another reason`);
  return `${total} plan${total === 1 ? "" : "s"} left out: ${parts.join(", ")}`;
}

/** What to change when no plan fits, from the reasons plans were actually left out: never advice that would not help. */
function nothingFitsAdvice(leftOut: MarketRunView["leftOut"]): string {
  const has = (code: string) => leftOut.some((l) => l.reason === code && l.count > 0);
  const steps: string[] = [];
  if (has("OVER_RATE")) steps.push("raise the hourly limit");
  if (has("OVER_BUDGET")) steps.push("raise the budget");
  if (has("TOO_SMALL")) steps.push("ask for a smaller machine");
  if (has("NO_REGION")) steps.push("allow more regions");
  if (has("SPOT_NOT_ALLOWED")) steps.push("allow interruptible machines");
  if (steps.length === 0) return "Change what you ask for, then try again.";
  return `${sentence(steps.join(", or ")).replace(/\.$/, "")}, then try again.`;
}

const QUOTE_NOTES: Record<string, string> = {
  OUT_OF_STOCK: "out of stock",
  SELLER_ERROR: "seller error",
  UNREACHABLE: "seller did not answer",
  PRICE_CAP: "quote over your budget",
  NO_402: "no price given",
  OVER_RATE: "quote over your hourly limit",
  OVER_BUDGET: "quote over your budget",
  OVER_QUOTE: "price raised",
  WRONG_ASSET: "asked for a different token",
  WRONG_NETWORK: "asked for a different network",
  ALREADY_PAID: "already paid",
  PAYMENT_REJECTED: "payment rejected",
  REFUSED_BY_GUARD: "payment refused",
};

/** A failed quote's code as a short status word. */
export function quoteNote(code: string | null): string {
  return (code && QUOTE_NOTES[code]) || "quote failed";
}

/**
 * "148 plans from x402layer", "0 spot offers from nuza", or what could not be read. The seller the
 * panel already names (`marketLabel`) is "the seller" here, so its name is not repeated.
 */
export function sourceLines(sources: MarketRunView["sources"], marketLabel?: string): { text: string; ok: boolean }[] {
  return sources.map((s) => {
    const spot = /nuza/i.test(s.name);
    const named = s.name === marketLabel;
    if (!s.ok) {
      const what = spot ? "Spot offers from nuza" : named ? "The seller's price list" : `The price list from ${s.name}`;
      return { text: `${what} could not be read${s.note ? ` (${s.note})` : ""}`, ok: false };
    }
    const n = s.count;
    const plans = `${n} plan${n === 1 ? "" : "s"}`;
    const text = spot ? `${n} spot offer${n === 1 ? "" : "s"} from nuza` : named ? `${plans} in the seller's price list` : `${plans} from ${s.name}`;
    return { text: s.note ? `${text} (${s.note})` : text, ok: true };
  });
}

/** "1 vCPU, 1 GB" or "H100, 80 GB GPU memory, 16 vCPUs"; 0 means the seller did not say. */
export function machineSize(r: Pick<OfferRow, "kind" | "vcpus" | "ramGb" | "vramGb" | "gpu">): string {
  const parts: string[] = [];
  if (r.kind === "gpu") {
    if (r.gpu) parts.push(r.gpu);
    if (r.vramGb > 0) parts.push(`${r.vramGb} GB GPU`);
  }
  if (r.vcpus > 0) parts.push(`${r.vcpus} vCPU${r.vcpus === 1 ? "" : "s"}`);
  if (r.ramGb > 0) parts.push(`${r.ramGb} GB`);
  return parts.join(", ") || "-";
}

/** What the run is doing, as the right column's heading. */
export const PHASE_HEADING: Record<MarketRunView["phase"], string> = {
  scanning: "Reading the price list",
  choosing: "Comparing plans",
  quoting: "Asking for firm quotes",
  approval: "Waiting for your approval",
  paying: "Paying over x402",
  provisioning: "Starting the machine",
  ready: "Machine ready",
  releasing: "Destroying the machine",
  released: "Machine destroyed",
  failed: "Run failed",
  refused: "Stopped before paying",
};

const REFUSALS: Record<string, { title: string; sentence: string }> = {
  CANCELLED: { title: "Cancelled", sentence: "You cancelled before paying. Nothing was spent." },
  STOPPED: { title: "Stopped", sentence: "Stopped before paying. Nothing was spent." },
  OVER_QUOTE: { title: "Payment refused", sentence: "The seller raised the price after quoting. Nothing was paid." },
  WRONG_ASSET: { title: "Payment refused", sentence: "The seller asked to be paid in a different token. Nothing was paid." },
  WRONG_NETWORK: { title: "Payment refused", sentence: "The seller asked to be paid on a different network. Nothing was paid." },
  OVER_BUDGET: { title: "Payment refused", sentence: "The payment would have gone over your budget. Nothing was paid." },
  OVER_RATE: { title: "Payment refused", sentence: "The payment would have gone over your hourly limit. Nothing was paid." },
  ALREADY_PAID: { title: "Payment refused", sentence: "This run had already paid once, so a second payment was refused. Nothing more was paid." },
};

export type EndState = { title: string; sentence: string; next: string | null; tone: "ink" | "bad" };

type EndRun = Pick<MarketRunView, "phase" | "refusal" | "error" | "leftOut" | "need" | "payment" | "machine" | "spent">;

/**
 * What happened to the money once a payment was signed, said only when `spent` is not "nothing": the
 * exact amount as paid or as sent and not confirmed (left out when `said` already names it), then
 * what is left to do. Null when nothing was signed.
 */
function moneyNext(run: EndRun, said: string): string | null {
  if (run.spent === "nothing") return null;
  const amount = run.payment ? usdExact(run.payment.atomic) : null;
  const parts: string[] = [];
  if (!amount || !said.includes(amount)) {
    const what = amount ?? "a payment";
    parts.push(run.spent === "paid" ? `${sentence(`${what} was paid`)}` : amount ? `A payment of ${amount} was sent and is not confirmed.` : "A payment was sent and is not confirmed.");
  }
  if (run.machine && run.machine.status !== "destroyed") parts.push("The machine may still be running. Use Destroy now below.");
  else if (!run.machine) parts.push("It stays listed under open purchases until you dismiss it.");
  return parts.join(" ");
}

/** How a finished run ended, in plain words, with what to do next. Null while it is going or after a clean release. */
export function endState(run: EndRun): EndState | null {
  if (run.phase === "refused") {
    const code = run.refusal?.code ?? "";
    // After a signed payment no refusal may say nothing was spent.
    if (run.spent !== "nothing") {
      const said = sentence(run.refusal?.detail || "The run stopped");
      return { title: "Stopped", sentence: said, next: moneyNext(run, said), tone: "bad" };
    }
    if (code === "NOTHING_FITS") {
      const summary = leftOutSummary(run.leftOut, run.need);
      return {
        title: "No plan fits",
        sentence: "No plan fits. Nothing was spent.",
        next: `${summary ? `${summary}. ` : ""}${nothingFitsAdvice(run.leftOut)}`,
        tone: "ink",
      };
    }
    const known = REFUSALS[code];
    if (known) return { ...known, next: code === "CANCELLED" || code === "STOPPED" ? null : "Start a new run to get a fresh quote.", tone: "ink" };
    return {
      title: "Stopped before paying",
      sentence: `${sentence(run.refusal?.detail || "The run stopped before paying").replace(/\.$/, "")}. Nothing was paid.`,
      next: "Start a new run to try again.",
      tone: "ink",
    };
  }
  if (run.phase === "failed") {
    const said = sentence(run.error?.trim() || "The run failed");
    if (run.spent !== "nothing") return { title: "Run failed", sentence: said, next: moneyNext(run, said), tone: "bad" };
    const next = /no wallet/i.test(said) ? "Set up the wallet for this market, then start again." : "Nothing was spent. Start a new run to try again.";
    return { title: "Run failed", sentence: said, next, tone: "bad" };
  }
  return null;
}
