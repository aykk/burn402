"use client";

import { useState, type ReactNode } from "react";
import type { MarketRunView } from "@/lib/market/run";
import { ActionError, type Post } from "./ActionError";
import { Swatch } from "./BudgetMeter";
import { clock, usd4 } from "./format";
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
export function MachinePanel({ run, nowMs, post }: { run: MarketRunView; nowMs: number; post: Post }) {
  const [destroying, setDestroying] = useState(false);
  const [destroyError, setDestroyError] = useState<string | null>(null);
  const m = run.machine;
  const p = run.payment;
  if (!m && !p) return null;

  const gone = m?.status === "destroyed" || run.phase === "released";
  const releasing = run.phase === "releasing";
  const canDestroy = m !== null && !gone && run.phase !== "paying";
  // A failed destroy leaves the run on ready (or failed) with the reason in its error.
  const runError = !gone && run.error && /destroy/i.test(run.error) ? run.error : null;

  const destroy = async () => {
    setDestroyError(null);
    setDestroying(true);
    setDestroyError(await post("/api/market/destroy", { run: run.id }));
    setDestroying(false);
  };

  const secondsLeft = m?.destroyAt != null ? Math.max(0, (m.destroyAt - nowMs) / 1000) : null;

  return (
    <section aria-labelledby="machine-heading" className="space-y-3 border-l-2 pl-3" style={{ borderColor: gone ? "var(--rule)" : "var(--foreground)" }}>
      <h3 id="machine-heading" className="text-[13.5px] leading-5 font-semibold text-foreground">
        {gone ? "The machine you rented" : "Your machine"}
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
        {!m && p && (
          <Row k="Status">
            <span className="text-muted">Paid. Waiting for the seller to report the machine.</span>
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
          <Row k="Paid">
            <span className="inline-flex flex-wrap items-center gap-x-2">
              <Swatch />
              <span className="font-semibold tabular-nums">{usd4(p.usd)} USDC</span>
              {p.tx ? (
                <a href={solscanUrl(p.tx, run.market)} target="_blank" rel="noreferrer" className="text-[12px] leading-4">
                  Payment on Solscan
                </a>
              ) : (
                <span className="text-[12px] leading-4 text-muted">The seller did not report a transaction id.</span>
              )}
            </span>
          </Row>
        )}
      </dl>

      {canDestroy && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button className={BTN} disabled={destroying || releasing} onClick={() => void destroy()}>
              {destroying || releasing ? "Destroying…" : "Destroy now"}
            </button>
            {runError && !destroyError && <span className="min-w-0 text-bad">{sentence(runError)}</span>}
          </div>
          <ActionError what="The machine wasn't destroyed" message={destroyError} onDismiss={() => setDestroyError(null)} />
        </div>
      )}
    </section>
  );
}
