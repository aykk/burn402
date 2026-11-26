import fs from "node:fs";
import path from "node:path";
import { usdPlain } from "./money";
import type { MarketId } from "./types";

export type JournalEvent = "intent" | "paid" | "unknown" | "active" | "released" | "failed";

export type JournalEntry = {
  at: number;
  run: string;
  market: MarketId;
  seller: string;
  event: JournalEvent;
  plan: string;
  region: string;
  usd: number;
  tx?: string | null;
  instance?: string | null;
  detail?: string;
};

export type OpenPurchase = {
  run: string;
  market: MarketId;
  seller: string;
  plan: string;
  region: string;
  usd: number;
  instance: string | null;
  tx: string | null;
  state: "paid" | "unknown" | "active";
  at: number;
  /** the latest journal event: "intent" means the outcome was never recorded */
  lastEvent: "intent" | "paid" | "unknown" | "active";
  /** one plain sentence on what this purchase is */
  what: string;
  /** a purchase the overspend test made (its runs are named ovs_...), not one of the owner's */
  overspendTest: boolean;
};

/** One plain sentence for an open purchase. */
function describeOpen(p: Pick<OpenPurchase, "plan" | "region" | "usd" | "instance" | "lastEvent">): string {
  const usd = usdPlain(p.usd);
  const what = `${p.plan} in ${p.region}`;
  if (p.instance) return `Paid ${usd} for ${what}. Machine ${p.instance} may still be running.`;
  if (p.lastEvent === "paid" || p.lastEvent === "active") return `The seller kept a payment of ${usd} for ${what} and delivered no machine.`;
  if (p.lastEvent === "unknown") return `A payment of ${usd} for ${what} was signed and sent, and it is not known whether it went through. No machine is known for it.`;
  return `A purchase of ${what} was started and its outcome was never recorded. A payment of up to ${usd} may have been made.`;
}

const EVENTS: readonly string[] = ["intent", "paid", "unknown", "active", "released", "failed"];

/** Append-only record of purchases. An intent is written before signing, so a crash leaves a trace. */
export class Journal {
  constructor(private readonly file: string) {}

  append(entry: JournalEntry): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Leading newline: a previous write cut off mid-line must not swallow this entry (all() skips blank lines).
    const fd = fs.openSync(this.file, "a", 0o600);
    try {
      fs.writeSync(fd, "\n" + JSON.stringify(entry) + "\n");
      fs.fsyncSync(fd); // an intent must survive a power loss
    } finally {
      fs.closeSync(fd);
    }
  }

  all(): JournalEntry[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const out: JournalEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line) as JournalEntry;
        if (v && typeof v === "object" && typeof v.run === "string" && EVENTS.includes(v.event)) out.push(v);
      } catch {
        // a torn or corrupt line must not hide the others
      }
    }
    return out;
  }

  /** Runs whose money may be out: latest event is intent (reported unknown), paid, unknown or active. */
  open(): OpenPurchase[] {
    const runs = new Map<string, Omit<OpenPurchase, "lastEvent" | "what" | "overspendTest"> & { event: JournalEvent }>();
    for (const x of this.all()) {
      const prev = runs.get(x.run);
      runs.set(x.run, {
        run: x.run,
        market: x.market,
        seller: x.seller,
        plan: x.plan,
        region: x.region,
        usd: x.usd,
        instance: x.instance ?? prev?.instance ?? null,
        tx: x.tx ?? prev?.tx ?? null,
        state: "unknown",
        at: x.at,
        event: x.event,
      });
    }
    const open: OpenPurchase[] = [];
    for (const { event, ...p } of runs.values()) {
      if (event === "released" || event === "failed") continue;
      const lastEvent = event;
      open.push({
        ...p,
        state: event === "paid" || event === "active" ? event : "unknown",
        lastEvent,
        what: describeOpen({ ...p, lastEvent }),
        overspendTest: p.run.startsWith("ovs_"),
      });
    }
    return open;
  }

  hasPayment(run: string): boolean {
    return this.all().some((x) => x.run === run && x.event === "intent");
  }
}

export function defaultJournal(root: string = process.cwd()): Journal {
  return new Journal(path.join(root, ".burn402", "purchases.jsonl"));
}
