"use client";

import { Nav } from "@/app/nav";
import { Segmented } from "@/app/components/Segmented";
import { INPUT, MONO } from "@/app/components/ui";
import { useEffect, useState } from "react";

type Step = { name: string; ok: boolean; detail: string };
type Outcome = { label: string; tone: "good" | "bad" | "warn" };

type Record = {
  id: string;
  schema: string;
  kind: "verdict" | "transaction" | "conversation";
  headline: string;
  rawUrl: string;
  explorerUrl: string | null;
  issuedAt: number | null;
  anchoredAt: number | null;
  subject: string | null;
  reason: string | null;
  outcome: Outcome;
  verified: boolean;
  steps: Step[];
};
type Response = { network: string; fqdn: string | null; gatewayUrl?: string; records?: Record[]; error?: string };

const TONE: { [K in Outcome["tone"]]: string } = { good: "var(--ok)", bad: "var(--bad)", warn: "var(--muted)" };

const KIND: { [K in Record["kind"]]: string } = { verdict: "Verdict", transaction: "Transaction", conversation: "Negotiation" };

const OUTCOMES = [
  { value: "all", label: "Everything" },
  { value: "good", label: "Allowed" },
  { value: "warn", label: "Refused" },
  { value: "bad", label: "Broken rules" },
  { value: "negotiation", label: "Negotiations" },
] as const;

// Mainnet is permanent, so its button carries a red dot (and a red outline on hover and focus).
const NETWORKS = [
  { value: "testnet", label: "Testnet" },
  { value: "production", label: "Mainnet", danger: true },
] as const;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const shortAgent = (ans: string) => ans.replace(/^ans:\/\/v[\d.]+\./, "");

/** "JFbqlL…G9Iw": enough to recognise a record; the full id goes in the title. */
const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

/** Sentence-case step names ("arweave item" becomes "Arweave item"; "ans proof" becomes "ANS proof"). */
const stepName = (name: string) => sentence(name.replace(/\bans\b/gi, "ANS"));

/** Machine tokens inside a check's detail: ANS names, hashes, key ids, constants. They render in mono. */
const MACHINE = /(ans:\/\/[^\s,;]+|sha256:[0-9a-f]+|\b[A-Z]{2,}(?:[ _][A-Z0-9]+)*_[A-Z0-9]+\b|[A-Za-z0-9_-]{24,})/g;

function Detail({ text }: { text: string }) {
  const parts = text.split(MACHINE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-mono break-all">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** The outcome in a few words so it never wraps the column: "signatures verified, some held back" is the long one. */
function outcomeLabel(r: Record): string {
  if (/^signatures verified, some held back$/i.test(r.outcome.label)) {
    const held = r.steps.map((s) => /(\d+) held back/.exec(s.detail)?.[1]).find(Boolean);
    return held ? `Verified, ${held} kept private` : "Verified, some kept private";
  }
  return sentence(r.outcome.label);
}

/** Money in the site's format: "0.005500 USDC" becomes "$0.0055 USDC"; "provisioned 0.263/hr against mandate rate 0.25/hr" becomes an hourly sentence. */
function moneyCopy(text: string): string {
  return text
    .replace(/provisioned \$?([\d.]+)\/hr against mandate rate \$?([\d.]+)\/hr/i, (_, a: string, b: string) => `provisioned at $${a} an hour against a $${b} limit`)
    .replace(/\$?(\d+\.\d+) USDC/g, (_, n: string) => `$${Number(n).toFixed(4)} USDC`);
}

function when(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const at = new Date(seconds * 1000);
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 19)} UTC`;
}

export default function RecordsPage() {
  const [network, setNetwork] = useState<"testnet" | "production">("production");
  const [outcome, setOutcome] = useState<"all" | "good" | "warn" | "bad" | "negotiation">("all");
  const [agent, setAgent] = useState("");
  const [needle, setNeedle] = useState("");
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
        const res = await fetch(`/api/records?network=${network}`, { cache: "no-store" });
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
  }, [network]);

  const records = data?.records ?? [];
  const agents = [...new Set(records.map((r) => r.subject ?? "").filter(Boolean))].sort();
  const shown = records.filter(
    (r) =>
      (outcome === "all" || (outcome === "negotiation" ? r.kind === "conversation" : r.outcome.tone === outcome && r.kind !== "conversation")) &&
      (agent === "" || r.subject === agent) &&
      (needle === "" ||
        `${r.headline} ${r.outcome.label} ${r.reason ?? ""} ${r.subject ?? ""} ${r.kind} ${r.id} ${when(r.issuedAt) ?? ""}`.toLowerCase().includes(needle.toLowerCase())),
  );

  const where = (data?.network ?? network) === "production" ? "mainnet" : "testnet";
  const count = data?.records && !loading
    ? shown.length === records.length
      ? `${records.length} record${records.length === 1 ? "" : "s"}`
      : `${shown.length} of ${records.length} records`
    : "Records";

  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-col px-4 py-5 sm:px-6 lg:px-10 lg:py-6">
      <Nav current="/records">
        <span className="flex items-center gap-3">
          <span className="text-muted">Arweave</span>
          <Segmented label="Arweave network" options={NETWORKS} value={network} onChange={setNetwork} />
        </span>
      </Nav>

      <div className="shrink-0 pt-2">
        <h1 className="text-[20px] leading-[26px] font-semibold">
          {count} on Arweave {where}
        </h1>
        {/* The line is always there so the page does not jump when the gateway arrives. */}
        <p className="mt-1 min-h-4 text-[12px] leading-4 text-muted">
          {data?.gatewayUrl && (
            <>
              Gateway <span className="font-mono">{data.gatewayUrl}</span>
            </>
          )}
        </p>
        <p className="mt-3 max-w-[64ch] text-muted">
          Every handshake, transaction and failure is written to Arweave. Testnet is for trying things out; mainnet is permanent and public.
          Reload the page to read them again.
        </p>
      </div>

      {/* The document scrolls; from 640px up the filters stay pinned to the top (on a phone they would take a quarter of the screen). */}
      <div className="z-20 mt-3 flex sm:sticky sm:top-0 shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-b border-rule bg-background pt-3 pb-4">
        {/* Five joined buttons do not fit a phone; below 640px the same choice is a select. */}
        <div className="hidden sm:block">
          <Segmented label="Outcome" options={OUTCOMES} value={outcome} onChange={setOutcome} />
        </div>
        <select
          aria-label="Outcome"
          className={`${INPUT} w-full sm:hidden`}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as typeof outcome)}
        >
          {OUTCOMES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select aria-label="Agent" className={`${INPUT} w-full sm:w-[260px]`} value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">Every agent</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {shortAgent(a)}
            </option>
          ))}
        </select>
        <input
          type="text"
          aria-label="Search records"
          className={`${INPUT} basis-full sm:flex-1 sm:basis-48`}
          placeholder="Search"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
        />
      </div>

      {loading && <div className="mt-4 shrink-0 text-muted">Reading from Arweave and checking each record…</div>}
      {data?.error && <div className="mt-4 shrink-0 text-bad">{data.error}</div>}
      {data?.records && !loading && (
        <div className="pb-4">
          {shown.length === 0 && <div className="pt-4 text-muted">Nothing matches those filters.</div>}
          {shown.map((r) => {
            const tone = TONE[r.outcome.tone];
            // One red per row: an unverified signature is only red when the outcome is otherwise good.
            const sigBad = !r.verified && r.outcome.tone === "good";
            return (
              <article
                key={r.id}
                className="grid gap-y-1.5 border-b border-rule py-[14px] lg:grid-cols-[96px_minmax(0,1fr)_180px_150px] lg:gap-x-6 lg:gap-y-2"
              >
                <div className="text-[12px] leading-5 text-muted">{KIND[r.kind] ?? r.kind}</div>
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{sentence(moneyCopy(r.headline))}</div>
                  {r.reason && <div className="text-muted">{sentence(moneyCopy(r.reason))}</div>}
                  {r.subject && <div className={`mt-0.5 break-all text-muted ${MONO}`}>{shortAgent(r.subject)}</div>}
                </div>
                <div>
                  <div className="font-medium" style={{ color: tone }}>
                    {outcomeLabel(r)}
                  </div>
                  <div
                    className={`text-[12px] leading-4 ${sigBad ? "text-bad" : "text-muted"}`}
                    title={sigBad ? "Red here because money moved on a record whose signature could not be verified" : undefined}
                  >
                    {r.verified ? "Signature verified" : "Signature not verified"}
                  </div>
                </div>
                <div className="text-[12px] leading-5 text-muted tabular-nums lg:text-right">
                  {when(r.issuedAt) ?? when(r.anchoredAt) ?? "Date not on record"}
                </div>
                <div className="min-w-0 space-y-1.5 text-[12px] leading-4 lg:col-span-3 lg:col-start-2">
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <a href={r.rawUrl} target="_blank" rel="noreferrer" title={r.id}>
                      Raw record <span className="font-mono">{shortId(r.id)}</span>
                    </a>
                    {r.explorerUrl && (
                      <a href={r.explorerUrl} target="_blank" rel="noreferrer">
                        Explorer
                      </a>
                    )}
                  </div>
                  <details className="group">
                    <summary className="flex w-fit cursor-pointer list-none items-baseline gap-1.5 text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
                      <span aria-hidden className="inline-block w-3 text-center text-foreground">
                        <span className="group-open:hidden">+</span>
                        <span className="hidden group-open:inline">−</span>
                      </span>
                      <span>
                        <span className="group-open:hidden">Show</span>
                        <span className="hidden group-open:inline">Hide</span> what was checked
                      </span>
                    </summary>
                    <div className="mt-2 grid grid-cols-1 gap-y-1 border-l-2 border-rule pl-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
                      {r.steps.map((s) => (
                        <div key={s.name} className="contents">
                          <div className="text-foreground">{stepName(s.name)}</div>
                          <div className="mb-1 min-w-0 break-words text-muted sm:mb-0">
                            {!s.ok && <span className="mr-2 font-medium text-bad">Failed</span>}
                            <Detail text={s.detail} />
                          </div>
                        </div>
                      ))}
                      <div className="mt-1 text-foreground">Run it yourself</div>
                      <div className="min-w-0 break-all font-mono text-muted sm:mt-1">
                        npm run burn402 -- verify {r.id}
                        {data.network === "production" ? " --network production" : ""}
                      </div>
                    </div>
                  </details>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
