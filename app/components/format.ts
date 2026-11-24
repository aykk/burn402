import type { TrainingRunView } from "@/lib/demo/train";
import type { DatasetSource } from "@/lib/train";

export const REGIONS: Record<string, string> = { ewr: "New Jersey", ord: "Chicago", atl: "Atlanta", lax: "Los Angeles", sjc: "Silicon Valley" };

export const PHASE_TEXT: Record<TrainingRunView["phase"], string> = {
  negotiating: "Your agent is talking to the broker",
  paying: "Paying for the server over x402",
  booting: "The server is booting",
  training: "Training on the rented server",
  publishing: "Collecting the model",
  done: "Done",
  failed: "Stopped",
};

export function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

export function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "-";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function size(dataset: DatasetSource): string {
  if (dataset.rows > 0) return `about ${dataset.rows.toLocaleString()} rows`;
  return `${Math.round(dataset.bytes / 1024).toLocaleString()} KB`;
}

export function kb(bytes: number | null): string {
  return bytes === null ? "-" : bytes > 900000 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Displayed amounts never go below zero or show NaN. */
const safe = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);

/**
 * The site's two money formats. Budgets and limits read in cents ("$0.50", "$1.25"), keeping extra
 * digits only when the amount really has them ("$0.125"), so a typed limit is never rounded away.
 */
export function usd2(n: number): string {
  const v = parseFloat(safe(n).toFixed(4));
  const cents = v * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-9 ? `$${v.toFixed(2)}` : `$${v}`;
}

/** Job-level costs and prices (payments, quotes, plan rates) always carry four decimals: "$0.0026". */
export function usd4(n: number): string {
  return `$${safe(n).toFixed(4)}`;
}

/**
 * Dollar amounts inside backend prose, in the same two formats: up to two decimals is a budget or a
 * limit ("$0.5" becomes "$0.50"), more is a price ("$0.262" becomes "$0.2620").
 */
export function moneyText(text: string): string {
  return text.replace(/\$(\d+(?:\.\d+)?)/g, (_, n: string) => ((n.split(".")[1]?.length ?? 0) <= 2 ? usd2(Number(n)) : usd4(Number(n))));
}

export function collapseLog(log: { at: number; text: string }[]): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  for (const line of log) {
    const step = /^(.*?)\s(\d+)\s+of\s+(\d+)$/.exec(line.text);
    const last = out[out.length - 1];
    if (step && last) {
      const prior = /^(.*?)\s(\d+)\s+of\s+(\d+)$/.exec(last.text);
      if (prior && prior[1] === step[1]) {
        out[out.length - 1] = { at: line.at, text: `${step[1]} ${step[2]}/${step[3]}` };
        continue;
      }
    }
    out.push(step ? { at: line.at, text: `${step[1]} ${step[2]}/${step[3]}` } : line);
  }
  return out;
}
