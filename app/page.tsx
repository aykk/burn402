"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Nav } from "@/app/nav";
import type { Snapshot } from "@/lib/demo/snapshot";
import type { PriceComparison } from "@/lib/market/prices/compare";
import type { MarketRunView } from "@/lib/market/run";
import { BudgetMeter } from "@/app/components/BudgetMeter";
import { LogDrawer } from "@/app/components/LogDrawer";
import type { Send } from "@/app/components/MachinePanel";
import { MarketPanel } from "@/app/components/MarketPanel";
import { ModelPicker } from "@/app/components/ModelPicker";
import { MarketPrices } from "@/app/components/MarketPrices";
import { NeedForm, needText, type CompareBody, type NeedDraft } from "@/app/components/NeedForm";
import { MARKET_NAME, hoursText, panelBody } from "@/app/components/market-copy";
import { OpenPurchases } from "@/app/components/OpenPurchases";
import { BTN } from "@/app/components/ui";
import { ActionError, UNREACHABLE, failureMessage, type Post } from "@/app/components/ActionError";
import { marketAnnouncement, marketMark, type MarketMark } from "@/app/components/announce";

const ENDED = new Set<MarketRunView["phase"]>(["released", "failed", "refused"]);
/** Money has moved and a machine is coming, running or going: the meter is what to watch. */
const PINNED = new Set<MarketRunView["phase"]>(["paying", "provisioning", "ready", "releasing"]);

export default function Page() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  // Only the 1.5s state poll writes this: it means the page has lost the server. Action failures live
  // next to their controls instead, so the next good poll cannot wipe them.
  const [error, setError] = useState<{ message: string; unreachable: boolean } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const logButton = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState<NeedDraft>({ budgetUsd: 1, rateUsdHr: 0.05, valid: true });
  // Bumped when a run starts, so focus moves from the form (which collapses) to the run's heading.
  const [startSignal, setStartSignal] = useState(0);
  const meterRef = useRef<HTMLDivElement>(null);
  const [resetSignal, setResetSignal] = useState(0);
  // Server clock minus client clock (ms), refreshed on every poll, so the meter ticks in server time.
  const clockOffset = useRef(0);
  const [tick, setTick] = useState(0);
  // Prices compared from the form without a run: shown in the right column (in place of an ended run's body)
  // until closed, a run starts, or Reset.
  const [compare, setCompare] = useState<(CompareBody & { seq: number; prices: PriceComparison | null }) | null>(null);
  // Only the latest comparison may land; a closed or replaced one is dropped and its request cancelled.
  const compareSeq = useRef(0);
  const compareAbort = useRef<AbortController | null>(null);
  // Bumped when the comparison is closed: the form moves focus to Compare prices once it is enabled again.
  const [compareClosed, setCompareClosed] = useState(0);

  const load = useCallback(async () => {
    let res: Response;
    try {
      res = await fetch("/api/demo/state", { cache: "no-store" });
    } catch (e) {
      setError({ message: (e as Error).message, unreachable: true });
      return;
    }
    try {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (typeof body.nowMs === "number") clockOffset.current = body.nowMs - Date.now();
      setSnap(body);
      setError(null);
    } catch (e) {
      setError({ message: (e as Error).message, unreachable: false });
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const poll = setInterval(load, 1500);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [load]);

  const run = snap?.market ?? null;

  // A payment the page saw listed under open purchases and that is gone from it now was dismissed: the run's
  // end line stops saying it stays listed. A run never seen listed keeps the default wording.
  const listedNow = run !== null && (snap?.openPurchases ?? []).some((p) => p.run === run.id);
  const [seenListed, setSeenListed] = useState<string | null>(null);
  if (run && listedNow && seenListed !== run.id) setSeenListed(run.id);
  const listed = !(run && seenListed === run.id && !listedNow);

  // Run milestones for screen readers (stages, approval, payment, machine, how it ended), never the per-second drain.
  // `undefined` until the first snapshot, so loading the page on an old run is a silent baseline.
  const lastMark = useRef<MarketMark | null | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!snap) return;
    const said = marketAnnouncement(lastMark.current, run);
    lastMark.current = run ? marketMark(run) : null;
    if (said) setAnnouncement(said);
  }, [snap, run]);

  /** Posts and reloads; resolves to the failure, or to the server's own note on success (destroy can say "nothing is running"). */
  const send: Send = async (path, body) => {
    let res: Response;
    try {
      res = await fetch(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      return { error: UNREACHABLE, message: null };
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) return { error: json.error ?? `The server answered HTTP ${res.status}`, message: null };
    await load();
    return { error: null, message: typeof json.message === "string" && json.message.trim() ? json.message : null };
  };
  const post: Post = async (path, body) => (await send(path, body)).error;

  const closeDrawer = useCallback(() => setDrawer(false), []);

  /** Reads market prices for a need. Starts no run, quotes nothing, pays nothing. */
  const comparePrices = async (body: CompareBody): Promise<string | null> => {
    const seq = ++compareSeq.current;
    compareAbort.current?.abort();
    const abort = new AbortController();
    compareAbort.current = abort;
    setCompare({ ...body, seq, prices: null });
    try {
      const res = await fetch("/api/market/prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abort.signal });
      const json = (await res.json()) as { prices?: PriceComparison; error?: string };
      if (!res.ok || !json.prices) throw new Error(json.error ?? `The server answered HTTP ${res.status}`);
      if (seq === compareSeq.current) setCompare({ ...body, seq, prices: json.prices });
      return null;
    } catch (e) {
      if (seq !== compareSeq.current) return null;
      setCompare(null);
      return failureMessage(e);
    }
  };
  /** Drops the comparison and cancels its request, so the Compare button is enabled again at once. */
  const dropCompare = () => {
    compareSeq.current++;
    compareAbort.current?.abort();
    compareAbort.current = null;
    setCompare(null);
  };
  const closeCompare = () => {
    dropCompare();
    setCompareClosed((k) => k + 1);
  };
  /** Over an ended run: back to that run, with focus on its heading. */
  const backToRun = () => {
    dropCompare();
    setStartSignal((k) => k + 1);
  };

  const running = run !== null && !ENDED.has(run.phase);
  const pinned = run !== null && PINNED.has(run.phase);
  // When the run ends the meter stays pinned a moment longer, so the drain and the flame going out are seen.
  const [wasPinned, setWasPinned] = useState(false);
  const [lingering, setLingering] = useState(false);
  if (pinned !== wasPinned) {
    setWasPinned(pinned);
    if (!pinned) setLingering(true);
  }
  // The meter's height, for anything that must sit below it while it is pinned (the form column, scroll targets).
  useEffect(() => {
    const el = meterRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const set = () => document.documentElement.style.setProperty("--meter-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // On a phone the form is below a finished run: this takes you back to it.
  const rentAnother = () => {
    const col = document.getElementById("need");
    col?.scrollIntoView({ block: "start" });
    col?.querySelector<HTMLElement>('h2[tabindex="-1"]')?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!lingering) return;
    const id = setTimeout(() => setLingering(false), 3000);
    return () => clearTimeout(id);
  }, [lingering]);

  // While a run is live (and the server answers), tick once a second so the meter and the time left move between polls.
  useEffect(() => {
    if (!running || error) return;
    const id = setInterval(() => setTick(Date.now() + clockOffset.current), 1000);
    return () => clearInterval(id);
  }, [running, error]);
  const nowMs = running ? Math.max(tick, snap?.nowMs ?? 0) : (snap?.nowMs ?? 0);

  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-col px-4 py-5 sm:px-6 lg:px-10 lg:py-6">
      <Nav current="/" burning={running}>
        {snap && (
          <ModelPicker
            models={snap.models}
            disabled={running}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onSave={(provider, key) => post("/api/demo/model", { provider, key })}
          />
        )}
        <button
          ref={logButton}
          className="underline decoration-1 underline-offset-[3px] hover:decoration-2"
          aria-haspopup="dialog"
          aria-expanded={drawer}
          onClick={() => setDrawer(true)}
        >
          Log
        </button>
        {/* Reset is destructive: set apart from the rest by a rule, quiet until pointed at. */}
        <button
          className="border-l border-rule pl-6 text-muted hover:text-foreground hover:underline hover:decoration-1 hover:underline-offset-[3px]"
          title="Forget this session: cancels a run waiting for approval, destroys a test-market machine, clears the log"
          onClick={async () => {
            setResetError(null);
            const failed = await post("/api/demo/reset");
            // A refused reset keeps the form as it was, so it still matches what the server holds.
            if (failed) setResetError(failed);
            else {
              setResetSignal((k) => k + 1);
              dropCompare();
            }
          }}
        >
          Reset
        </button>
      </Nav>

      {/* A cold visitor learns what this is in two short lines; the meter under it stays the biggest thing on the page.
          The promise first, in two beats (what you do, what the agent does), then how, in one plain sentence. */}
      <div className="shrink-0 pt-3">
        <h1 className="text-[28px] leading-[34px] font-semibold tracking-[-0.015em]">Set a budget. Your agent rents the compute.</h1>
        <p className="mt-1.5 max-w-[72ch] text-[16px] leading-[24px] text-muted">
          It finds the cheapest machine that fits, pays with x402, and destroys it when the time is up.
        </p>
      </div>

      {/* Focus lands here after the last open purchase is dismissed, where the run's money is told. */}
      {/* From the payment until the machine is gone the meter stays in view (pinned in globals.css, on screens
          big enough to spare the room); the page-colored strip above it hides what scrolls underneath. */}
      <div ref={meterRef} tabIndex={-1} className={`mt-1 shrink-0 bg-background pt-3 focus:outline-none ${pinned || lingering ? "meter-pinned" : ""}`}>
        <BudgetMeter
          agentName={snap?.company?.name ?? null}
          formBudgetUsd={draft.budgetUsd}
          formRateUsdHr={draft.rateUsdHr}
          draftValid={draft.valid}
          listed={listed}
          job={run}
          nowMs={nowMs}
        />
      </div>

      {run && !running && (
        <div className="mt-3 shrink-0 lg:hidden">
          <button type="button" className={BTN} onClick={rentAnother}>
            Start another rental
          </button>
        </div>
      )}

      {snap && snap.openPurchases.length > 0 && (
        <div className="mt-6 shrink-0">
          <OpenPurchases purchases={snap.openPurchases} send={send} onGone={() => meterRef.current?.focus()} />
        </div>
      )}

      {resetError && (
        <div className="mt-4 shrink-0">
          <ActionError what="Reset didn't finish" message={resetError} onDismiss={() => setResetError(null)} />
        </div>
      )}

      {error && (
        <div role="status" className="mt-4 shrink-0 text-bad">
          {error.unreachable
            ? `Can't reach the demo server (${error.message}). Start it with: npm run dev`
            : `The demo server couldn't report its state (${error.message}). Check the terminal running npm run dev.`}
        </div>
      )}

      {/* One column template in every phase, so nothing jumps when a run starts, pays or ends. The form column
          is 26rem: its container is 25rem after the padding, wide enough for three number fields in a row
          (NeedForm switches at 24rem), and the run column keeps room for the plan table. Below lg the columns
          stack, with the run first while there is one. */}
      <section className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-10">
        <div id="need" className={`form-col lg:pr-4 lg:pb-6 ${run ? "border-t border-rule pt-8 lg:border-t-0 lg:pt-0" : ""}`}>
          <NeedForm
            snap={snap}
            run={run}
            collapsed={running}
            running={running}
            resetSignal={resetSignal}
            onDraftChange={setDraft}
            onStart={async (body) => {
              const failed = await post("/api/market/run", body);
              if (!failed) {
                setStartSignal((k) => k + 1);
                dropCompare();
              }
              return failed;
            }}
            onCompare={comparePrices}
            compareClosed={compareClosed}
            onAddKey={() => setPickerOpen(true)}
          />
        </div>

        <div
          className={`border-rule lg:sticky lg:top-6 lg:self-start lg:border-l lg:pt-0 lg:pr-2 lg:pb-6 lg:pl-10 ${
            run ? "order-first lg:order-none" : "border-t pt-8 lg:border-t-0"
          }`}
        >
          <MarketPanel
            run={run}
            nowMs={nowMs}
            listed={listed}
            focusSignal={startSignal}
            walletReady={snap?.walletReady ?? { test: false, real: false }}
            post={post}
            send={send}
            compare={
              compare && (
                <MarketPrices
                  key={compare.seq}
                  prices={compare.prices}
                  loading={compare.prices === null}
                  heading="h2"
                  onClose={closeCompare}
                  onBack={run && panelBody(run, true) === "compare" ? backToRun : undefined}
                  focusOnShow
                  intro={`For ${needText(compare.need)}, ${hoursText(compare.need.hours)}, on the ${MARKET_NAME[compare.market].toLowerCase()}.`}
                  outro="Nothing was rented or paid."
                />
              )
            }
          />
        </div>
      </section>

      <LogDrawer open={drawer} onClose={closeDrawer} log={snap?.log ?? []} returnFocus={logButton} />

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
    </main>
  );
}
