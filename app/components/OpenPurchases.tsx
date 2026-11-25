"use client";

import { useRef, useState } from "react";
import type { OpenPurchase } from "@/lib/market/journal";
import { ActionError } from "./ActionError";
import { clock } from "./format";
import type { Send } from "./MachinePanel";
import { MARKET_NAME, sentence } from "./market-copy";
import { BTN, MONO } from "./ui";

function Purchase({ p, send }: { p: OpenPurchase; send: Send }) {
  const [busy, setBusy] = useState<"destroy" | "dismiss" | null>(null);
  const [error, setError] = useState<{ what: string; message: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const inFlight = useRef(false);
  // A payment with no machine (the seller kept it, or it was never confirmed) has nothing to destroy: the owner
  // checks it and dismisses it. Anything with a machine, or a machine still to be looked for, gets Destroy.
  const noMachine = p.instance === null && (p.lastEvent === "paid" || p.lastEvent === "unknown");
  const canDestroy = p.instance !== null || p.lastEvent !== "paid";

  const act = async (kind: "destroy" | "dismiss") => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setError(null);
      setNote(null);
      setBusy(kind);
      const r = await send("/api/market/destroy", kind === "dismiss" ? { open: { run: p.run }, dismiss: true } : { open: { run: p.run } });
      if (r.error) setError({ what: kind === "dismiss" ? "That purchase wasn't dismissed" : "That machine wasn't destroyed", message: r.error });
      setNote(r.message);
    } finally {
      setBusy(null);
      inFlight.current = false;
    }
  };

  return (
    <li className="space-y-2">
      <p className="max-w-[72ch] text-foreground">{p.what}</p>
      <p className="text-[12px] leading-4 text-muted">
        {MARKET_NAME[p.market]}, last recorded at {clock(p.at).slice(0, 5)} UTC
        {p.overspendTest ? ". Made by the overspend test, not by you." : ""}
        {p.tx && (
          <>
            {" "}
            Transaction <span className={MONO} title={p.tx}>{`${p.tx.slice(0, 4)}…${p.tx.slice(-4)}`}</span>
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {canDestroy && (
          <button className={BTN} disabled={busy !== null} onClick={() => void act("destroy")}>
            {busy === "destroy" ? "Destroying…" : "Destroy"}
          </button>
        )}
        {noMachine && (
          <button className={BTN} disabled={busy !== null} aria-describedby={`dismiss-${p.run}`} onClick={() => void act("dismiss")}>
            {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
          </button>
        )}
        {noMachine && (
          <span id={`dismiss-${p.run}`} className="min-w-0 text-[12px] leading-4 text-muted">
            Dismiss once you have checked the payment. The purchase journal keeps a line saying you did.
          </span>
        )}
        {note && !error && <span className="min-w-0 text-foreground">{sentence(note)}</span>}
      </div>
      <ActionError what={error?.what ?? ""} message={error?.message ?? null} onDismiss={() => setError(null)} />
    </li>
  );
}

/**
 * Purchases the journal holds open: money may be out and nothing closed them. A machine from a run before
 * this one (a restart, or a reset on the real market) gets Destroy; a payment with no machine gets Dismiss.
 */
export function OpenPurchases({ purchases, send }: { purchases: OpenPurchase[]; send: Send }) {
  if (purchases.length === 0) return null;
  return (
    <section aria-labelledby="open-heading" className="space-y-3 border-l-2 border-bad pl-3">
      <h2 id="open-heading" className="font-semibold text-foreground">
        {purchases.length === 1 ? "An open purchase to check" : `${purchases.length} open purchases to check`}
      </h2>
      <ul className="space-y-4">
        {purchases.map((p) => (
          <Purchase key={p.run} p={p} send={send} />
        ))}
      </ul>
    </section>
  );
}
