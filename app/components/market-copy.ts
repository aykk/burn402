import { usdExact } from "../../lib/market/money";
import type { PriceComparison } from "@/lib/market/prices/compare";
import { SOURCE_URLS, type MarketPrice, type PriceSource } from "../../lib/market/prices/types";
import type { MarketRunView, OfferRow } from "@/lib/market/run";
import type { MarketId, Need } from "@/lib/market/types";
import { REGIONS, clock, duration, usd4 } from "./format";

/** "The last problem: The seller" reads "The last problem: the seller": no capital after a colon mid-sentence. */
export const colonCase = (t: string) => t.replace(/: (The|A|An|No|Nothing|It|This) /g, (_, w: string) => `: ${w.toLowerCase()} `);

/** Backend prose is lowercase fragments; shown as a sentence. */
export const sentence = (t: string) => {
  const s = colonCase(t.trim().charAt(0).toUpperCase() + t.trim().slice(1));
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

export const MARKET_NAME: Record<MarketId, string> = { test: "Test market", real: "Real market" };

/** The exact amount being approved ("$0.010382"), never rounded: the owner approves a specific payment. */
export function approvalSentence(a: NonNullable<MarketRunView["approval"]>): string {
  return `Pay ${a.exact} for ${hoursText(a.hours)} of ${a.plan} in ${a.region}.`;
}

/** Where the money goes, under the approval sentence: the token, the network and the seller's wallet. */
export function approvalDetail(a: NonNullable<MarketRunView["approval"]>): string {
  return `Paid in ${a.token} on ${a.network}, to the seller's wallet ${shortAddress(a.payTo)}.`;
}

/**
 * When the seller bills more hours than were asked for: "The seller bills a 2-hour minimum; you asked for 1 hour."
 * More than the whole hours asked can only come from a minimum; otherwise it is rounding up to whole hours.
 */
export function billedHoursLine(askedHours: number, billedHours: number): string | null {
  if (!(billedHours > askedHours + 1e-9)) return null;
  const why = billedHours > Math.ceil(askedHours - 1e-9) + 1e-9 ? `a ${parseFloat(billedHours.toFixed(2))}-hour minimum` : `whole hours: ${hoursText(billedHours)}`;
  return `The seller bills ${why}; you asked for ${hoursText(askedHours)}.`;
}

/** "Includes the seller's 15% surcharge for rentals under 24 hours.", or null when the quote has none. */
export function surchargeLine(s: NonNullable<MarketRunView["approval"]>["surcharge"]): string | null {
  if (!s) return null;
  return `Includes the seller's ${s.pct}% surcharge for rentals under ${hoursText(s.underHours)}.`;
}

const NETWORK: Record<MarketId, string> = { test: "Solana devnet", real: "Solana mainnet" };

type PaymentFacts = Pick<NonNullable<MarketRunView["payment"]>, "atomic" | "status">;

/** The payment as the meter states it: settled only once confirmed, always the exact amount. */
export function paymentLine(p: PaymentFacts, market: MarketId, opts: { amount?: boolean } = {}): string {
  // Without the amount when the meter's big figure already is that amount.
  const amount = opts.amount === false ? "" : ` ${usdExact(p.atomic)}`;
  return p.status === "confirmed" ? `Paid${amount} over x402, confirmed on ${NETWORK[market]}.` : `Sent${amount} over x402 on ${NETWORK[market]}, not confirmed yet.`;
}

/**
 * After the machine is destroyed: what the payment bought, how long it ran, and that unused time stays paid,
 * as short labelled facts (one sentence holding all three was too long to scan).
 * The amount itself is the meter's big figure right above, so it is not repeated here.
 */
export function prepaidFacts(p: PaymentFacts, hours: number, ranSeconds: number | null): { label: string; value: string }[] {
  const facts = [p.status === "confirmed" ? { label: "Paid for", value: hoursText(hours) } : { label: "Sent for", value: `${hoursText(hours)}, not confirmed yet` }];
  if (ranSeconds !== null) facts.push({ label: "Ran for", value: timeLeft(ranSeconds) });
  facts.push({ label: "Unused time", value: "Not refunded by this app. The seller decides." });
  return facts;
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
    if (r.gpu) parts.push(r.gpu.replace(/_/g, " "));
    if (r.vramGb > 0) parts.push(`${r.vramGb} GB GPU`);
  }
  if (r.vcpus > 0) parts.push(`${r.vcpus} vCPU${r.vcpus === 1 ? "" : "s"}`);
  if (r.ramGb > 0) parts.push(`${r.ramGb} GB`);
  return parts.join(", ") || "-";
}

/** A note that the agent used another region: known region codes named by city ("New Jersey (ewr)"), as a sentence. */
export function fallbackLine(text: string): string {
  const named = text.replace(/\b([a-z]{3})\b/g, (code: string) => (REGIONS[code] ? `${REGIONS[code]} (${code})` : code));
  return sentence(named);
}

/** What the run is doing, as the right column's heading. */
export const PHASE_HEADING: Record<MarketRunView["phase"], string> = {
  scanning: "Reading the price list",
  choosing: "Comparing plans",
  quoting: "Getting exact prices",
  approval: "Waiting for your approval",
  paying: "Paying",
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
function moneyNext(run: EndRun, said: string, listed: boolean): string | null {
  if (run.spent === "nothing") return null;
  const amount = run.payment ? usdExact(run.payment.atomic) : null;
  const parts: string[] = [];
  if (!amount || !said.includes(amount)) {
    const what = amount ?? "a payment";
    parts.push(run.spent === "paid" ? `${sentence(`${what} was paid`)}` : amount ? `A payment of ${amount} was sent and is not confirmed.` : "A payment was sent and is not confirmed.");
  }
  if (run.machine && run.machine.status !== "destroyed") parts.push("The machine may still be running. Use Destroy now below.");
  else if (!run.machine) parts.push(listed ? "It stays listed under open purchases until you dismiss it." : "It is no longer listed under open purchases.");
  return parts.join(" ");
}

/** How a finished run ended, in plain words, with what to do next. Null while it is going or after a clean release. */
export function endState(run: EndRun, opts: { listed?: boolean } = {}): EndState | null {
  // `listed`: the run's payment is still under open purchases (false once the owner dismissed it).
  const listed = opts.listed ?? true;
  if (run.phase === "refused") {
    const code = run.refusal?.code ?? "";
    // After a signed payment no refusal may say nothing was spent.
    if (run.spent !== "nothing") {
      const said = sentence(run.refusal?.detail || "The run stopped");
      return { title: "Stopped", sentence: said, next: moneyNext(run, said, listed), tone: "bad" };
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
    if (run.spent !== "nothing") return { title: "Run failed", sentence: said, next: moneyNext(run, said, listed), tone: "bad" };
    const next = /no wallet/i.test(said) ? "Set up the wallet for this market, then start again." : "Nothing was spent. Start a new run to try again.";
    return { title: "Run failed", sentence: said, next, tone: "bad" };
  }
  return null;
}

/** "a", "a and b", "a, b and c" (or "or"). */
export function listJoin(items: string[], word: "and" | "or" = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${word} ${items[items.length - 1]}`;
}

/** Providers by their short names in running text; the table uses the full source label. */
const SOURCE_SHORT: Record<PriceSource, string> = { vultr: "Vultr", vast: "Vast.ai", runpod: "RunPod", akash: "Akash" };
const shortName = (s: { source: PriceSource; label: string }) => SOURCE_SHORT[s.source] ?? s.label;

/** True when no provider's prices could be read (or none were asked). */
export function pricesAllFailed(p: Pick<PriceComparison, "sources">): boolean {
  return !p.sources.some((s) => s.ok);
}

/**
 * "Live prices from Vultr, Vast.ai and Akash, read at 19:42 UTC." then one line per source that failed
 * ("RunPod did not answer in time."). When none could be read, one line saying so.
 */
export function priceSourceLines(p: Pick<PriceComparison, "sources" | "asOf">): { text: string; ok: boolean }[] {
  if (pricesAllFailed(p)) {
    const names = p.sources.map(shortName);
    return [{ text: `No live prices could be read${names.length > 0 ? ` from ${listJoin(names, "or")}` : ""}. The rental itself is unaffected.`, ok: false }];
  }
  const read = { text: `Live prices from ${listJoin(p.sources.filter((s) => s.ok).map(shortName))}, read at ${clock(p.asOf).slice(0, 5)} UTC.`, ok: true };
  // A source that was read but gave a note ("has nothing in stock right now") says it, not as a failure.
  const noted = p.sources.filter((s) => s.ok && s.note?.trim()).map((s) => ({ text: sentence(`${shortName(s)} ${s.note!.trim()}`), ok: true }));
  const failed = p.sources.filter((s) => !s.ok).map((s) => ({ text: sentence(`${shortName(s)} ${s.note?.trim() || "could not be read"}`), ok: false }));
  return [read, ...noted, ...failed];
}

/**
 * The lead line: the comparison's own sentence. When no provider could be read, that sentence would
 * say none lists a fit, which is not known; only what the agent can buy is said then (or that the
 * seller's list could not be read either), and whether it is buying an interruptible machine.
 */
export function pricesLead(p: PriceComparison): string | null {
  if (!pricesAllFailed(p)) return p.sentence;
  const parts: string[] = [];
  const b = p.buyable;
  if (b) {
    const rate = `${usd4(b.hourlyUsd)} an hour through ${b.seller}`;
    parts.push(b.paid ? `Your agent paid ${rate}.` : `The cheapest your agent can buy is ${b.firm ? "a quoted" : "an estimated"} ${rate}.`);
  } else if (p.sellerUnreadable) parts.push("The seller's price list could not be read either.");
  if (p.buyingSpot) parts.push("Your agent is buying an interruptible machine; its rate is not compared with list prices.");
  return parts.length > 0 ? parts.join(" ") : null;
}

const squash = (t: string) => t.toLowerCase().replace(/^(nvidia|amd|intel)\s+/, "").replace(/[\s_-]+/g, "");

/** "NVIDIA A16, 16 GB GPU memory, 6 vCPUs, 60 GB RAM": the GPU model only when the name does not already say it; 0 = not stated. */
export function priceMachine(p: Pick<MarketPrice, "name" | "kind" | "gpu" | "vramGb" | "vcpus" | "ramGb">): string {
  const parts: string[] = [];
  if (p.kind === "gpu") {
    if (p.gpu && !squash(p.name).startsWith(squash(p.gpu))) parts.push(p.gpu.replace(/_/g, " "));
    if (p.vramGb > 0) parts.push(`${p.vramGb} GB GPU memory`);
  }
  if (p.vcpus > 0) parts.push(`${p.vcpus} vCPU${p.vcpus === 1 ? "" : "s"}`);
  if (p.ramGb > 0) parts.push(`${p.ramGb} GB RAM`);
  return parts.join(", ");
}

/** The 4-decimal figure the page prints: "cheapest" compares these, so a printed tie marks every tied row. */
const shown4 = (n: number) => Math.round(n * 1e4);

/** Which rows are the cheapest fit anywhere, the buyable plan included; ties (as printed) are all marked. */
export function cheapestMarks(p: Pick<PriceComparison, "best" | "buyable">): { rows: boolean[]; buyable: boolean } {
  const rates = [...p.best.map((r) => r.hourlyUsd), ...(p.buyable ? [p.buyable.hourlyUsd] : [])];
  if (rates.length === 0) return { rows: [], buyable: false };
  const low = Math.min(...rates.map(shown4));
  return { rows: p.best.map((r) => shown4(r.hourlyUsd) <= low), buyable: p.buyable !== null && shown4(p.buyable.hourlyUsd) <= low };
}

/** The buyable row's answer to "Can your agent buy here?". */
export function buyableWord(b: Pick<NonNullable<PriceComparison["buyable"]>, "firm"> & { paid?: boolean }): string {
  return b.paid ? "Yes, paid" : b.firm ? "Yes, firm quote" : "Yes, estimate";
}

/** The machine the agent can buy, in the same words as a provider's row: "NVIDIA A16, 16 GB GPU memory, 6 vCPUs, 60 GB RAM". */
export function buyableMachine(b: NonNullable<PriceComparison["buyable"]>): string {
  return priceMachine({ name: b.plan, kind: b.kind, gpu: b.gpu, vramGb: b.vramGb, vcpus: b.vcpus, ramGb: b.ramGb });
}

/** One provider row in the market prices table. */
export type PriceRow = {
  key: string;
  sourceLabel: string;
  name: string;
  url: string;
  /** GPU, memory, vCPUs, RAM; secondary */
  detail: string;
  /** a Vast.ai host's region, named plainly */
  region: string | null;
  outsideRegions: boolean;
  note: string | null;
  hourlyUsd: number;
  spotHourlyUsd: number | null;
  cheapest: boolean;
  /** the plan the agent can buy, sold direct by its provider */
  same: boolean;
};

/**
 * The provider rows: each source's cheapest fit, and the same machine bought direct (marked, and added
 * when it is not its source's cheapest fit). `cheapest` marks the lowest price, the agent's included.
 */
export function priceRows(p: Pick<PriceComparison, "best" | "buyable" | "sameMachine">): PriceRow[] {
  const marks = cheapestMarks(p);
  const same = p.sameMachine;
  const isSame = (r: { source: PriceSource; name: string }) => same !== null && r.source === same.source && r.name === same.name;
  const rows: PriceRow[] = p.best.map((r, i) => ({
    key: `${r.source}:${r.name}`,
    sourceLabel: r.sourceLabel,
    name: r.name,
    url: r.url,
    detail: priceMachine(r),
    region: r.source === "vast" ? r.region : null,
    outsideRegions: r.outsideRegions === true,
    note: r.note,
    hourlyUsd: r.hourlyUsd,
    // an interruptible figure not below the on-demand one reads like an error; it is left out
    spotHourlyUsd: r.spotHourlyUsd !== null && r.spotHourlyUsd < r.hourlyUsd ? r.spotHourlyUsd : null,
    cheapest: marks.rows[i] ?? false,
    same: isSame(r),
  }));
  if (same && p.buyable && !rows.some((r) => r.same)) {
    const low = Math.min(...p.best.map((r) => shown4(r.hourlyUsd)), shown4(p.buyable.hourlyUsd));
    rows.push({
      key: `${same.source}:${same.name}:same`,
      sourceLabel: same.sourceLabel,
      name: same.name,
      url: SOURCE_URLS[same.source],
      detail: buyableMachine(p.buyable),
      region: null,
      outsideRegions: false,
      note: null,
      hourlyUsd: same.hourlyUsd,
      spotHourlyUsd: null,
      cheapest: shown4(same.hourlyUsd) <= low,
      same: true,
    });
    rows.sort((a, b) => a.hourlyUsd - b.hourlyUsd);
  }
  return rows;
}

/**
 * What the right panel shows. A run in flight always. A comparison in place of an ended run only when that
 * run needs nothing from the owner: released, or refused or failed with nothing spent and no machine. Any
 * other ended run (a machine it still knows about, a payment made or maybe made) keeps its body, with the
 * comparison under it ("run+compare"), so Destroy now and the money message are never hidden.
 */
export type PanelBody = "intro" | "compare" | "run" | "run+compare";
export function panelBody(run: Pick<MarketRunView, "phase" | "spent" | "machine"> | null, compareOpen: boolean): PanelBody {
  if (!run) return compareOpen ? "compare" : "intro";
  if (run.phase !== "released" && run.phase !== "failed" && run.phase !== "refused") return "run";
  if (!compareOpen) return "run";
  const settled = run.phase === "released" || (run.spent === "nothing" && run.machine === null);
  return settled ? "compare" : "run+compare";
}

/** A provider page is linked only when it is plain https. */
export function safeLink(url: string): string | null {
  return url.startsWith("https://") ? url : null;
}
