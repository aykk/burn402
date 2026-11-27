import { publicReal, type Visitor } from "../market/access";
import type { OpenPurchase } from "../market/journal";
import { visibleOpenPurchases } from "../market/recover";
import type { MarketRunView } from "../market/run";
import { marketJournal, walletReady } from "../market/session";
import type { LogLine } from "./log";
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
  log: LogLine[];
  market: MarketRunView | null;
  /** journal purchases that were paid and not released; the current run is left out only while it is still going */
  openPurchases: OpenPurchase[];
  walletReady: { test: boolean; real: boolean };
  /** true when the owner has opened the real market to public visitors (who pay from their own wallets) */
  publicReal: boolean;
};

/** An absolute path on this computer, as it might appear inside an error message. */
const SERVER_PATH = /(?:\/(?:Users|home|private|var|tmp|opt|Volumes)\/[^\s'"`,;)]*)/g;

/** Every string in `value` with server paths replaced; a public visitor never learns the owner's folders. */
export function withoutPaths<T>(value: T): T {
  if (typeof value === "string") return value.replace(SERVER_PATH, "a file on the server") as unknown as T;
  if (Array.isArray(value)) return value.map((v) => withoutPaths(v)) as unknown as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutPaths(v)])) as T;
  return value;
}

/** A public visitor's machine never shows where its key sits on the server, and no error text carries a server path. */
function publicView(market: MarketRunView): MarketRunView {
  const m = market.machine;
  const view = m && m.ssh !== null ? { ...market, machine: { ...m, ssh: m.ip ? `ssh root@${m.ip}` : null } } : market;
  return withoutPaths(view);
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
    log: s ? (kind === "public" ? withoutPaths(s.log.lines) : s.log.lines) : [],
    market: market && kind === "public" ? publicView(market) : market,
    openPurchases,
    walletReady: kind === "owner" ? ready : { test: ready.test, real: ready.real && publicReal() },
    publicReal: publicReal(),
  };
}

/** The snapshot for one visitor. The approval code in it pays for a purchase; it only ever goes to the session that owns the run. */
export function snapshotFor(rt: Runtime, s: DemoSession | null, v: Visitor): Snapshot {
  return snapshot(rt, s, v.kind);
}
