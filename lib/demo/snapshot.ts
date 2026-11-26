import type { OpenPurchase } from "../market/journal";
import { visibleOpenPurchases } from "../market/recover";
import type { MarketRunView } from "../market/run";
import { isLocalHost, marketJournal, walletReady } from "../market/session";
import type { LogLine } from "./log";
import { modelsView, type ModelsView } from "./models";
import type { DemoSession } from "./script";

export type Snapshot = {
  /** seconds */
  now: number;
  /** the same instant in ms, for comparing with MarketRunView times (all ms) */
  nowMs: number;
  network: "testnet" | "production";
  models: ModelsView;
  log: LogLine[];
  market: MarketRunView | null;
  /** journal purchases that were paid and not released; the current run is left out only while it is still going */
  openPurchases: OpenPurchase[];
  walletReady: { test: boolean; real: boolean };
};

export function snapshot(s: DemoSession): Snapshot {
  const rt = s.rt;
  const market = s.market?.view() ?? null;
  let openPurchases: OpenPurchase[] = [];
  try {
    openPurchases = visibleOpenPurchases(marketJournal(rt.config.root).open(), market);
  } catch {
    // an unreadable journal must not break the page
  }
  const nowMs = Date.now();
  return {
    now: nowMs / 1000,
    nowMs,
    network: rt.network,
    models: modelsView(),
    log: rt.log.lines,
    market,
    openPurchases,
    walletReady: walletReady(),
  };
}

/**
 * The snapshot for one HTTP request. The approval code pays for a purchase, so it is only
 * handed to requests addressed to 127.0.0.1:3000 or localhost:3000; a DNS-rebinding page
 * reaches the app under its own host name and gets `market.approval: null`.
 */
export function snapshotFor(s: DemoSession, request: Request): Snapshot {
  const state = snapshot(s);
  if (!isLocalHost(request) && state.market) state.market = { ...state.market, approval: null };
  return state;
}
