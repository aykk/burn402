"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { usdExact } from "@/lib/market/money";
import type { MarketRunView } from "@/lib/market/run";
import { ActionError } from "./ActionError";
import type { FocusNext } from "./MarketPanel";

/** A post that also returns the server's note on success, e.g. destroy answering "nothing is running". */
export type Send = (path: string, body?: unknown) => Promise<{ error: string | null; message: string | null }>;
import { Swatch } from "./BudgetMeter";
import { clock } from "./format";
import { sentence, solscanUrl, timeLeft } from "./market-copy";
import { BTN, MONO, TEXT_BTN } from "./ui";

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** The SSH command with a Copy button; the button says Copied for two seconds. */
function SshLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <code className={`min-w-0 [overflow-wrap:anywhere] text-foreground ${MONO}`}>{command}</code>
      <button type="button" className={`shrink-0 text-[12px] leading-4 ${TEXT_BTN}`} onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
      <span role="status" className="sr-only">
        {copied ? "SSH command copied" : ""}
      </span>
      {failed && <span className="text-[12px] leading-4 text-muted">Select the command and copy it by hand.</span>}
    </div>
  );
}

/**
 * The rented machine: where it is, how to reach it, how long it has left, the payment, and Destroy now.
 * Shown from the moment a payment lands until the run is over.
 */
/** How long Destroy now stays off after it first appears, so a second click meant for Pay cannot land on it. */
const ARM_MS = 2000;

const ENDED = new Set<MarketRunView["phase"]>(["released", "failed", "refused"]);

export function MachinePanel({
  run,
  nowMs,
  send,
  headingRef,
  onFocusNext,
}: {
  run: MarketRunView;
  nowMs: number;
  send: Send;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  onFocusNext?: (next: FocusNext) => void;
}) {
  const [destroying, setDestroying] = useState(false);
  const [destroyError, setDestroyError] = useState<string | null>(null);
  const [destroyNote, setDestroyNote] = useState<string | null>(null);
  // The run whose Destroy now has been on screen for ARM_MS; until then it is shown, but off.
  const [armedRun, setArmedRun] = useState<string | null>(null);
  // Blocks a second click in the same tick, before the busy state has rendered.
  const inFlight = useRef(false);
  const m = run.machine;
  const p = run.payment;
  // The run this page watched before its machine existed. Only then can a click meant for Pay land on Destroy
  // now, so only then is it held off; on a page loaded with the machine already up it works at once.
  const [watchedRun, setWatchedRun] = useState<string | null>(null);
  if (!m && watchedRun !== run.id) setWatchedRun(run.id);

  // Gone only when the run says released; the seller-reported status alone does not end the machine block.
  const gone = run.phase === "released";
  const releasing = run.phase === "releasing";
  const canDestroy = m !== null && !gone && run.phase !== "paying";
  const armed = armedRun === run.id || watchedRun !== run.id;

  useEffect(() => {
    if (!canDestroy || armed) return;
    const id = setTimeout(() => setArmedRun(run.id), ARM_MS);
    return () => clearTimeout(id);
  }, [canDestroy, armed, run.id]);

  if (!m && !p) return null;

  // A failed destroy leaves the run on ready (or failed) with the reason in its error.
  const runError = !gone && run.error && /destroy/i.test(run.error) ? run.error : null;
  const confirmed = p?.status === "confirmed";
  const ended = ENDED.has(run.phase);

  const destroy = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setDestroyError(null);
      setDestroyNote(null);
      setDestroying(true);
      onFocusNext?.("heading");
      const r = await send("/api/market/destroy", { run: run.id });
      if (r.error) onFocusNext?.(null);
      setDestroyError(r.error);
      setDestroyNote(r.message);
    } finally {
      setDestroying(false);
      inFlight.current = false;
    }
  };
  const solscan = p ? solscanUrl(p.tx, run.market) : null;

  const secondsLeft = m?.destroyAt != null ? Math.max(0, (m.destroyAt - nowMs) / 1000) : null;

  return (
    <section aria-labelledby="machine-heading" className="space-y-3 border-l-2 pl-3" style={{ borderColor: gone ? "var(--rule)" : "var(--foreground)" }}>
      <h3 id="machine-heading" ref={headingRef} tabIndex={-1} className="text-[13.5px] leading-5 font-semibold text-foreground focus:outline-none">
        {!m ? "Your payment" : gone ? "The machine you rented" : "Your machine"}
      </h3>

      <dl className="space-y-1.5">
        {m && (
          <Row k="Plan">
            {m.plan} in {m.region} <span className={`text-muted ${MONO}`}>{m.id}</span>
          </Row>
        )}
        {!gone && m && !m.ip && (
          <Row k="Status">
            <span className="text-foreground">{m.status}.</span>{" "}
            <span className="text-muted">Waiting for an address. On the real seller this usually takes 2 to 3 minutes.</span>
          </Row>
        )}
        {!m && p && !ended && (
          <Row k="Status">
            <span className="text-muted">
              {confirmed ? "Paid. Waiting for the seller to report the machine." : "Payment sent. Waiting for the seller to confirm it and report the machine."}
            </span>
          </Row>
        )}
        {!m && p && ended && (
          <Row k="Machine">
            <span className="text-foreground">None was delivered.</span>
          </Row>
        )}
        {!gone && m?.ip && (
          <Row k="IP address">
            <span className={`text-foreground ${MONO}`}>{m.ip}</span>
          </Row>
        )}
        {!gone && m?.ssh && (
          <Row k="SSH">
            <SshLine command={m.ssh} />
          </Row>
        )}
        {!gone && m?.ip && (
          <Row k="Port 22">
            {m.port22 === "open" ? (
              <span className="text-ok">Open</span>
            ) : m.port22 === "closed" ? (
              <span className="text-foreground">Closed. The machine may still be booting; try SSH in a minute.</span>
            ) : run.market === "test" ? (
              <span className="text-muted">Not checked: test machines have no real address.</span>
            ) : (
              <span className="text-muted">Checking</span>
            )}
          </Row>
        )}
        {!gone && run.phase === "ready" && secondsLeft !== null && (
          <Row k="Time left">
            <span className="font-medium text-foreground tabular-nums">{timeLeft(secondsLeft)}</span>
            <span className="text-muted">, destroyed at {clock(m!.destroyAt!).slice(0, 5)} UTC</span>
          </Row>
        )}
        {gone && (
          <Row k="Status">
            Destroyed{run.releasedAt ? ` at ${clock(run.releasedAt).slice(0, 5)} UTC` : ""} and gone from the seller&apos;s list.
          </Row>
        )}
        {p && (
          <Row k={confirmed ? "Paid" : "Sent"}>
            <span className="inline-flex flex-wrap items-center gap-x-2">
              <Swatch />
              <span className="font-semibold tabular-nums">{usdExact(p.atomic)} USDC</span>
              {!confirmed && <span className="text-foreground">not confirmed yet</span>}
              {solscan ? (
                <a href={solscan} target="_blank" rel="noreferrer" className="text-[12px] leading-4">
                  Payment on Solscan
                </a>
              ) : (
                <span className="text-[12px] leading-4 text-muted">{confirmed ? "The seller did not report a transaction id." : "No transaction id yet."}</span>
              )}
            </span>
          </Row>
        )}
      </dl>

      {canDestroy && (
        <div className="space-y-2">
          {/* At the far end of the block, never where Pay and rent was, and off for its first two seconds. */}
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
            {runError && !destroyError && <span className="min-w-0 text-bad">{sentence(runError)}</span>}
            <button className={BTN} disabled={!armed || destroying || releasing} aria-describedby={armed ? undefined : "destroy-wait"} onClick={() => void destroy()}>
              {destroying || releasing ? "Destroying…" : "Destroy now"}
            </button>
            {!armed && (
              <span id="destroy-wait" className="sr-only">
                Available in two seconds, so a second click meant for Pay and rent cannot destroy the machine.
              </span>
            )}
          </div>
          <ActionError what="The machine wasn't destroyed" message={destroyError} onDismiss={() => setDestroyError(null)} />
        </div>
      )}
      {destroyNote && !destroyError && <p className="text-foreground">{sentence(destroyNote)}</p>}
    </section>
  );
}
