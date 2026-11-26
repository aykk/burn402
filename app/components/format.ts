
export const REGIONS: Record<string, string> = { ewr: "New Jersey", ord: "Chicago", atl: "Atlanta", lax: "Los Angeles", sjc: "Silicon Valley" };

export function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

export function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "-";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** Displayed amounts never go below zero or show NaN. */
const safe = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);

/** "1234567.25" becomes "1,234,567.25": thousands separators on the whole dollars only. */
const grouped = (fixed: string) => fixed.replace(/^\d+/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ","));

/**
 * The site's two money formats. Budgets and limits read in cents ("$0.50", "$1.25"), keeping extra
 * digits only when the amount really has them ("$0.125"), so a typed limit is never rounded away.
 */
export function usd2(n: number): string {
  const v = parseFloat(safe(n).toFixed(4));
  const cents = v * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-9 ? `$${grouped(v.toFixed(2))}` : `$${grouped(String(v))}`;
}

/** Job-level costs and prices (payments, quotes, plan rates) always carry four decimals: "$0.0026". */
export function usd4(n: number): string {
  return `$${grouped(safe(n).toFixed(4))}`;
}

/**
 * Dollar amounts inside backend prose, in the same two formats: up to two decimals is a budget or a
 * limit ("$0.5" becomes "$0.50"), more is a price ("$0.262" becomes "$0.2620").
 */
export function moneyText(text: string): string {
  return text.replace(/\$(\d+(?:\.\d+)?)/g, (_, n: string) => ((n.split(".")[1]?.length ?? 0) <= 2 ? usd2(Number(n)) : usd4(Number(n))));
}
