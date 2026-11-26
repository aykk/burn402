import type { Visitor } from "../market/access";
import type { OpenPurchase } from "../market/journal";
import { visibleOpenPurchases } from "../market/recover";
import type { MarketRunView } from "../market/run";
import { marketJournal, walletReady } from "../market/session";
import type { LogLine } from "./log";
import { modelsView, type ModelsView } from "./models";
import type { Runtime } from "./runtime";
import type { DemoSession } from "./script";
import { allSessions } from "./session";

export type Snapshot = {
  /** seconds */
  now: number;
  /** the same instant in ms, for comparing with MarketRunView times (all ms) */
  nowMs: number;
  /** "owner": this computer, everything allowed. "public": a visitor on the public demo, test market only. */
  visitor: "owner" | "public";
  network: "testnet" | "production";
  /** The model picker's state; null for public visitors, who have no model. */
  models: ModelsView | null;
  log: LogLine[];
  market: MarketRunView | null;
  /** journal purchases that were paid and not released; the current run is left out only while it is still going */
  openPurchases: OpenPurchase[];
  walletReady: { test: boolean; real: boolean };
};

/** A public visitor's machine never shows where its key sits on the server: the path names the owner's folders. */
function publicView(market: MarketRunView): MarketRunView {
  const m = market.machine;
  if (!m || m.ssh === null) return market;
  return { ...market, machine: { ...m, ssh: m.ip ? `ssh root@${m.ip}` : null } };
}

/**
 * What one visitor sees. `s` is null for a public visitor who has not started anything yet: an idle
 * page, with no session kept for them. A public visitor only ever sees their own run, log and purchases.
 */
export function snapshot(rt: Runtime, s: DemoSession | null, kind: "owner" | "public"): Snapshot {
  const market = s?.market?.view() ?? null;
  let openPurchases: OpenPurchase[] = [];
  try {
    if (kind === "owner") {
      // everything in the journal, except purchases a live public session is still looking after
      const theirs = new Set(allSessions().filter((o) => o.kind === "public").flatMap((o) => [...o.runIds]));
      openPurchases = visibleOpenPurchases(marketJournal(rt.config.root).open(), market).filter((o) => !theirs.has(o.run));
    }
    else if (s && s.runIds.size > 0) openPurchases = visibleOpenPurchases(marketJournal(rt.config.root).open(), market).filter((o) => s.runIds.has(o.run));
  } catch {
    // an unreadable journal must not break the page
  }
  const nowMs = Date.now();
  const ready = walletReady();
  return {
    now: nowMs / 1000,
    nowMs,
    visitor: kind,
    network: rt.network,
    models: kind === "owner" ? modelsView() : null,
    log: s ? s.log.lines : [],
    market: market && kind === "public" ? publicView(market) : market,
    openPurchases,
    walletReady: kind === "owner" ? ready : { test: ready.test, real: false },
  };
}

/** The snapshot for one visitor. The approval code in it pays for a purchase; it only ever goes to the session that owns the run. */
export function snapshotFor(rt: Runtime, s: DemoSession | null, v: Visitor): Snapshot {
  return snapshot(rt, s, v.kind);
}
