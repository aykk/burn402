"use client";

import { useState } from "react";
import type { OpenPurchase } from "@/lib/market/journal";
import { ActionError, type Post } from "./ActionError";
import { clock, usd4 } from "./format";
import { MARKET_NAME } from "./market-copy";
import { BTN, MONO } from "./ui";

function Purchase({ p, post }: { p: OpenPurchase; post: Post }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const destroy = async () => {
    setError(null);
    setBusy(true);
    setError(await post("/api/market/destroy", { open: { run: p.run } }));
    setBusy(false);
  };
  return (
    <li className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0">
          <span className="font-medium text-foreground">
            {p.plan} in {p.region}
          </span>
          <span className="text-muted">
            , {MARKET_NAME[p.market].toLowerCase()}, paid {usd4(p.usd)} at {clock(p.at).slice(0, 5)} UTC
          </span>
          {p.instance && <span className={`ml-2 text-muted ${MONO}`}>{p.instance}</span>}
        </p>
        <button className={BTN} disabled={busy} onClick={() => void destroy()}>
          {busy ? "Destroying…" : "Destroy"}
        </button>
      </div>
      <ActionError what="That machine wasn't destroyed" message={error} onDismiss={() => setError(null)} />
    </li>
  );
}

/**
 * Purchases the journal says were paid and never released, from runs before this one (a restart, or a
 * reset on the real market). Each gets a Destroy button so no paid machine is left without a way to end it.
 */
export function OpenPurchases({ purchases, post }: { purchases: OpenPurchase[]; post: Post }) {
  if (purchases.length === 0) return null;
  return (
    <section aria-labelledby="open-heading" className="space-y-2 border-l-2 border-bad pl-3">
      <h2 id="open-heading" className="font-semibold text-foreground">
        {purchases.length === 1 ? "A machine from an earlier run may still be running" : `${purchases.length} machines from earlier runs may still be running`}
      </h2>
      <ul className="space-y-2">
        {purchases.map((p) => (
          <Purchase key={p.run} p={p} post={post} />
        ))}
      </ul>
    </section>
  );
}
