import fs from "node:fs";
import path from "node:path";
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
};

const EVENTS: readonly string[] = ["intent", "paid", "unknown", "active", "released", "failed"];

/** Append-only record of purchases. An intent is written before signing, so a crash leaves a trace. */
export class Journal {
  constructor(private readonly file: string) {}

  append(entry: JournalEntry): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 });
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
    const runs = new Map<string, OpenPurchase & { event: JournalEvent }>();
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
      open.push({ ...p, state: event === "paid" || event === "active" ? event : "unknown" });
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
