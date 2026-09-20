"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Step = { name: string; ok: boolean; detail: string };
type Outcome = { label: string; tone: "good" | "bad" | "warn" };

type Record = {
  id: string;
  schema: string;
  kind: "verdict" | "transaction";
  headline: string;
  rawUrl: string;
  explorerUrl: string | null;
  issuedAt: number | null;
  anchoredAt: number | null;
  subject: string | null;
  outcome: Outcome;
  verified: boolean;
  steps: Step[];
};
type Response = { network: string; fqdn: string | null; gatewayUrl?: string; records?: Record[]; error?: string };



const TONE: { [K in Outcome["tone"]]: string } = { good: "var(--ok)", bad: "var(--bad)", warn: "var(--warn)" };

function when(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const at = new Date(seconds * 1000);
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 19)} UTC`;
}

export default function RecordsPage() {
  const [network, setNetwork] = useState<"testnet" | "production">("production");
  const [fqdn, setFqdn] = useState("");
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const n = new URLSearchParams(window.location.search).get("network");
    if (n === "testnet") setTimeout(() => setNetwork("testnet"), 0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/records?network=${network}${fqdn ? `&fqdn=${encodeURIComponent(fqdn)}` : ""}`, { cache: "no-store" });
        const body = (await res.json()) as Response;
        if (!cancelled) setData(body);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const t = setTimeout(run, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [network, fqdn]);

  return (
    <main className="mx-auto w-full max-w-[1100px] px-4 py-4 space-y-4">
      <header className="flex flex-wrap items-center gap-4 border-b border-rule pb-2">
        <Link href="/" className="font-bold text-foreground no-underline">
          burn402
        </Link>
        <span className="font-bold">Arweave records</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-muted">Arweave</span>
          {(["testnet", "production"] as const).map((n) => (
            <button key={n} className={`border px-2 ${network === n ? "border-foreground font-bold" : "border-rule text-muted"}`} onClick={() => setNetwork(n)}>
              {n === "production" ? "mainnet" : "testnet"}
            </button>
          ))}
        </span>
      </header>

      <p className="max-w-[80ch]">
        All records (successful handshakes, transactions, failures) are written to Arweave. You can toggle between
        Testnet and Mainnet (Mainnet is truly permanent and public). Refresh page to reload.
      </p>

      <label className="flex flex-wrap items-center gap-2">
        <span className="text-muted">Filter by agent domain</span>
        <input
          className="min-w-0 flex-1 max-w-[380px] border border-rule px-2 py-1"
          placeholder="every agent"
          value={fqdn}
          onChange={(e) => setFqdn(e.target.value.trim())}
        />
      </label>

      {loading && <div className="text-muted">Reading from Arweave and checking each record…</div>}
      {data?.error && <div className="text-bad">{data.error}</div>}
      {data?.records && !loading && (
        <div className="space-y-4">
          <div>
            {data.records.length} record{data.records.length === 1 ? "" : "s"}
            {data.fqdn ? ` for ${data.fqdn}` : ""} on Arweave {data.network === "production" ? "mainnet" : "testnet"}.{" "}
            <span className="text-muted">Gateway: {data.gatewayUrl}</span>
          </div>
          {data.records.map((r) => (
            <div key={r.id} className="border border-rule p-3 space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-4">
                <span className="text-muted">{r.kind}</span>
                <span>{r.headline}</span>
                <span className="text-muted">{when(r.issuedAt) ?? when(r.anchoredAt) ?? "date not on record"}</span>
                <span className="text-muted">{r.subject}</span>
                <span className="ml-auto flex items-baseline gap-3">
                  <span className="font-bold" style={{ color: TONE[r.outcome.tone] }}>
                    {r.outcome.tone === "good" ? "✓" : r.outcome.tone === "bad" ? "✗" : "!"} {r.outcome.label}
                  </span>
                  <span className={r.verified ? "text-muted" : "text-bad"}>{r.verified ? "signature checks out" : "signature did not check out"}</span>
                </span>
              </div>
              <div className="break-all">
                <a href={r.rawUrl} target="_blank" rel="noreferrer">
                  raw record {r.id}
                </a>
                {r.explorerUrl && (
                  <>
                    {" · "}
                    <a href={r.explorerUrl} target="_blank" rel="noreferrer">
                      explorer
                    </a>
                  </>
                )}
              </div>
              <details>
                <summary className="cursor-pointer text-muted">What was checked</summary>
                {r.steps.map((s) => (
                  <div key={s.name} className={s.ok ? "text-ok" : "text-bad"}>
                    {s.ok ? "✓" : "✗"} {s.name}: <span className="text-muted break-all">{s.detail}</span>
                  </div>
                ))}
                <div className="text-muted mt-1">Run it yourself: npm run burn402 -- verify {r.id}{data.network === "production" ? " --network production" : ""}</div>
              </details>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
