import type { MarketRunView, OfferRow } from "@/lib/market/run";
import type { MarketId, Need } from "@/lib/market/types";
import { duration, usd4 } from "./format";

/** Backend prose is lowercase fragments; shown as a sentence. */
export const sentence = (t: string) => {
  const s = t.trim().charAt(0).toUpperCase() + t.trim().slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
};

/** "1 hour", "3 hours", "1.5 hours", "30 minutes". */
export function hoursText(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return "-";
  if (h < 1) {
    const m = Math.max(1, Math.round(h * 60));
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const n = parseFloat(h.toFixed(2));
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

export function solscanUrl(tx: string, market: MarketId): string {
  return `https://solscan.io/tx/${encodeURIComponent(tx)}${market === "test" ? "?cluster=devnet" : ""}`;
}

export const MARKET_NAME: Record<MarketId, string> = { test: "Test market (devnet)", real: "Real market (mainnet)" };

export function approvalSentence(a: NonNullable<MarketRunView["approval"]>): string {
  return `Pay ${usd4(a.usd)} ${a.token} to ${shortAddress(a.payTo)} on ${a.network} for ${a.plan} in ${a.region}, ${hoursText(a.hours)}.`;
}

/** Why a plan was left out, as the end of "22 too small". */
export function leftOutPhrase(reason: string, need: Pick<Need, "kind" | "regions">): string {
  switch (reason) {
    case "WRONG_KIND":
      return need.kind === "cpu" ? "with a GPU" : "without a GPU";
    case "TOO_SMALL":
      return "too small";
    case "OUT_OF_STOCK":
      return "out of stock";
    case "NO_REGION":
      return need.regions.length > 0 ? "not in your regions" : "with no region listed";
    case "SPOT_NOT_ALLOWED":
      return "interruptible";
    case "NOT_RENTABLE":
      return "not for rent";
    case "OVER_RATE":
      return "over your hourly limit";
    case "OVER_BUDGET":
      return "over your budget";
    default:
      return reason.toLowerCase().replace(/_/g, " ");
  }
}

/** "31 plans left out: 22 too small, 9 over your hourly limit", or null when none were. */
export function leftOutSummary(leftOut: MarketRunView["leftOut"], need: Pick<Need, "kind" | "regions">): string | null {
  const total = leftOut.reduce((n, l) => n + l.count, 0);
  if (total === 0) return null;
  return `${total} plan${total === 1 ? "" : "s"} left out: ${leftOut.map((l) => `${l.count} ${leftOutPhrase(l.reason, need)}`).join(", ")}`;
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

/** A failed quote's note ("OUT_OF_STOCK: seller answered 409") as a short status word. */
export function quoteNote(note: string | null): string {
  const code = note ? /^([A-Z_]+):/.exec(note)?.[1] : undefined;
  return (code && QUOTE_NOTES[code]) || "quote failed";
}

/** "148 plans from x402layer", "0 spot offers from nuza", or what could not be read. */
export function sourceLines(sources: MarketRunView["sources"]): { text: string; ok: boolean }[] {
  return sources.map((s) => {
    const spot = /nuza/i.test(s.name);
    if (!s.ok) {
      const what = spot ? "Spot offers from nuza" : `The price list from ${s.name}`;
      return { text: `${what} could not be read${s.note ? ` (${s.note})` : ""}`, ok: false };
    }
    const n = s.count;
    const text = spot ? `${n} spot offer${n === 1 ? "" : "s"} from nuza` : `${n} plan${n === 1 ? "" : "s"} from ${s.name}`;
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

/** How a finished run ended, in plain words, with what to do next. Null while it is going or after a clean release. */
export function endState(run: Pick<MarketRunView, "phase" | "refusal" | "error" | "leftOut" | "need" | "payment" | "machine">): EndState | null {
  if (run.phase === "refused") {
    const code = run.refusal?.code ?? "";
    if (code === "NOTHING_FITS") {
      const summary = leftOutSummary(run.leftOut, run.need);
      return {
        title: "No plan fits",
        sentence: "No plan fits. Nothing was spent.",
        next: `${summary ? `${summary}. ` : ""}Raise the hourly limit or the budget, or ask for a smaller machine, then try again.`,
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
    const error = run.error?.trim() || "The run failed";
    const machineUp = run.machine !== null && run.machine.status !== "destroyed";
    let next: string;
    if (/payment outcome unknown/i.test(error)) {
      next = `The payment may have gone through. Run npm run market:sweep to find and destroy any machine it bought.`;
    } else if (run.payment) {
      next = machineUp
        ? `${usd4(run.payment.usd)} was paid and the machine may still be running. Use Destroy now below.`
        : `${usd4(run.payment.usd)} was paid. Start a new run to try again.`;
    } else if (/no wallet/i.test(error)) {
      next = "Nothing was spent. Set up the wallet for this market, then start again.";
    } else {
      next = "Nothing was spent. Start a new run to try again.";
    }
    return { title: "Run failed", sentence: sentence(error), next, tone: "bad" };
  }
  return null;
}
