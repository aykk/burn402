import type { TrainingRunView } from "@/lib/demo/train";
import type { DatasetSource } from "@/lib/train";

export const REGIONS: Record<string, string> = { ewr: "New Jersey", ord: "Chicago", atl: "Atlanta", lax: "Los Angeles", sjc: "Silicon Valley" };

export const PHASE_TEXT: Record<TrainingRunView["phase"], string> = {
  negotiating: "your agent is talking to the broker",
  paying: "paying for the server over x402",
  booting: "the server is booting",
  training: "training on the rented server",
  publishing: "collecting the model",
  done: "done",
  failed: "stopped",
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

export function money(n: number | null): string {
  if (n === null) return "-";
  return n >= 1 ? `$${n.toFixed(2)}` : `$${parseFloat(n.toFixed(6))}`;
}

export function size(dataset: DatasetSource): string {
  if (dataset.rows > 0) return `about ${dataset.rows.toLocaleString()} rows`;
  return `${Math.round(dataset.bytes / 1024).toLocaleString()} KB`;
}

export function kb(bytes: number | null): string {
  return bytes === null ? "-" : bytes > 900000 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function toneOf(a: { ok: boolean; blocked: boolean | null }): string {
  if (a.blocked === null) return a.ok ? "var(--ok)" : "var(--bad)";
  return a.blocked ? "var(--bad)" : "var(--ok)";
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
