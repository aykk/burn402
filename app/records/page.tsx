"use client";

import { Nav } from "@/app/nav";
import { isUnreachable } from "../components/verify-state";
import { Segmented } from "@/app/components/Segmented";
import { usd2, usd4 } from "@/app/components/format";
import { BTN, INPUT, MONO, TEXT_BTN } from "@/app/components/ui";
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

type Check = { state: "verified" } | { state: "invalid"; label: string } | { state: "unchecked"; step: Step | null };

/** Verified, failed a check, or could not be checked at all. Only the second is the record's fault. */
function checkOf(r: Record): Check {
  if (r.verified) return { state: "verified" };
  const failed = r.steps.find((s) => !s.ok) ?? null;
  // Not verified with no failed step means the check never finished.
  if (!failed || isUnreachable(failed)) return { state: "unchecked", step: failed };
  if (/no signature attached/i.test(failed.detail)) return { state: "invalid", label: "No signature attached" };
  if (/signature/i.test(failed.name)) return { state: "invalid", label: "Signature invalid" };
  return { state: "invalid", label: `${stepName(failed.name)} check failed` };
}

/** A step's detail in words: a bare network error becomes what it means for the check. */
function stepDetail(s: Step): string {
  if (/^fetch failed$/i.test(s.detail)) return "the gateway did not answer (fetch failed)";
  if (/^fetch \S+: HTTP (\d+)$/i.test(s.detail)) return `the gateway answered HTTP ${/HTTP (\d+)/.exec(s.detail)![1]} instead of the record`;
  return s.detail;
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
    .replace(/provisioned \$?([\d.]+)\/hr against mandate rate \$?([\d.]+)\/hr/i, (_, a: string, b: string) => `provisioned at ${usd4(Number(a))} an hour against a ${usd2(Number(b))} limit`)
    .replace(/\$?(\d+\.\d+) USDC/g, (_, n: string) => `${usd4(Number(n))} USDC`);
}

function when(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const at = new Date(seconds * 1000);
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 19)} UTC`;
}

export default function RecordsPage() {
  // null until we know which network to open on: the one in the URL, else the one the demo writes to.
  const [network, setNetwork] = useState<"testnet" | "production" | null>(null);
  const [outcome, setOutcome] = useState<"all" | "good" | "warn" | "bad" | "negotiation">("all");
  const [agent, setAgent] = useState("");
  const [needle, setNeedle] = useState("");
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  // Why the list could not be read: the demo server is down, or it answered but the gateway did not.
  const [failure, setFailure] = useState<{ title: string; detail: string } | null>(null);
  // "Try again" and "Check again" bump this to run the same read once more.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const n = new URLSearchParams(window.location.search).get("network");
    if (n === "testnet" || n === "production") {
      setTimeout(() => setNetwork(n), 0);
      return;
    }
    // Open on the network the demo server writes its records to, so the records of a run just made are
    // the ones shown. If the server can't say, mainnet as before.
    let cancelled = false;
    fetch("/api/demo/state", { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { network?: string }) => {
        if (!cancelled) setNetwork(b.network === "testnet" ? "testnet" : "production");
      })
      .catch(() => {
        if (!cancelled) setNetwork("production");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (network === null) return;
    let cancelled = false;
    // A failed read keeps the records already on screen only if they are from the same network.
    const keepSameNetwork = (prev: Response | null) => (prev?.network === network ? prev : null);
    const run = async () => {
      setLoading(true);
      setFailure(null);
      try {
        const res = await fetch(`/api/records?network=${network}`, { cache: "no-store" });
        const body = (await res.json()) as Response;
        if (cancelled) return;
        if (!res.ok || body.error || !body.records) {
          setFailure({
            title: "Couldn't read the records from Arweave",
            detail: `The gateway didn't answer the demo server (${body.error ?? `HTTP ${res.status}`}). This is usually brief; try again in a moment.`,
          });
          setData(keepSameNetwork);
        } else {
          setData(body);
        }
      } catch (e) {
        if (cancelled) return;
        setFailure(
          e instanceof TypeError
            ? { title: "Couldn't load the records", detail: "The demo server didn't answer. Check that npm run dev is still running, then try again." }
            : { title: "Couldn't load the records", detail: "The demo server sent back a reply it couldn't read. Check the terminal running npm run dev." },
        );
        setData(keepSameNetwork);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const t = setTimeout(run, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [network, attempt]);

  const records = data?.records ?? [];
  const agents = [...new Set(records.map((r) => r.subject ?? "").filter(Boolean))].sort();
  const shown = records.filter(
    (r) =>
      (outcome === "all" || (outcome === "negotiation" ? r.kind === "conversation" : r.outcome.tone === outcome && r.kind !== "conversation")) &&
      (agent === "" || r.subject === agent) &&
      (needle === "" ||
        `${r.headline} ${r.outcome.label} ${r.reason ?? ""} ${r.subject ?? ""} ${r.kind} ${r.id} ${when(r.issuedAt) ?? ""}`.toLowerCase().includes(needle.toLowerCase())),
  );

  const shownNetwork = data?.network ?? network;
  const where = shownNetwork === null ? "" : shownNetwork === "production" ? " mainnet" : " testnet";
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
          {count} on Arweave{where}
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
      {failure && !loading && (
        <div role="alert" className="mt-4 shrink-0 space-y-3">
          <div>
            <p className="font-medium text-bad">{failure.title}</p>
            <p className="mt-1 max-w-[64ch] text-muted">
              {failure.detail}
              {data?.records ? " The list below is from the last read." : ""}
            </p>
          </div>
          <button type="button" className={BTN} onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
        </div>
      )}
      {data?.records && !loading && (
        <div className="pb-4">
          {shown.length === 0 && <div className="pt-4 text-muted">Nothing matches those filters.</div>}
          {shown.map((r) => {
            const check = checkOf(r);
            const unchecked = check.state === "unchecked";
            // A verdict whose record never arrived has no verdict to report; the route's defaults would read as a pass.
            const noVerdict = r.kind === "verdict" && !r.steps.some((s) => s.name === "verdict signature" && s.ok);
            const headline = unchecked && noVerdict ? "verdict could not be read from the gateway" : r.headline;
            // An outcome is only shown as settled once its check has run. Unchecked: muted, and said so.
            // A conversation's outcome is its verification, so a failed one reads as failed, not "could not be checked".
            // A transaction's outcome still comes from its tags, so it stays, muted, over "Couldn't check".
            const outcomeText = unchecked
              ? r.kind === "transaction"
                ? outcomeLabel(r)
                : "Not confirmed yet"
              : r.kind === "conversation" && check.state === "invalid"
                ? "Failed verification"
                : outcomeLabel(r);
            const tone = unchecked ? "var(--muted)" : TONE[r.outcome.tone];
            // One red per row: a failed check is red unless the outcome beside it is already red.
            const outcomeRed = !unchecked && r.outcome.tone === "bad";
            return (
              <article
                key={r.id}
                className="grid gap-y-1.5 border-b border-rule py-[14px] lg:grid-cols-[96px_minmax(0,1fr)_180px_150px] lg:gap-x-6 lg:gap-y-2"
              >
                <div className="text-[12px] leading-5 text-muted">{KIND[r.kind] ?? r.kind}</div>
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{sentence(moneyCopy(headline))}</div>
                  {r.reason && <div className="text-muted">{sentence(moneyCopy(r.reason))}</div>}
                  {r.subject && <div className={`mt-0.5 break-all text-muted ${MONO}`}>{shortAgent(r.subject)}</div>}
                </div>
                <div>
                  <div
                    className="font-medium"
                    style={{ color: tone }}
                    title={unchecked && r.kind === "transaction" ? "From the record's tags; not confirmed until its signed record can be checked" : undefined}
                  >
                    {outcomeText}
                  </div>
                  {check.state === "verified" && <div className="text-[12px] leading-4 text-ok">Verified</div>}
                  {check.state === "invalid" && (
                    <div className={`text-[12px] leading-4 font-medium ${outcomeRed ? "text-foreground" : "text-bad"}`}>{check.label}</div>
                  )}
                  {check.state === "unchecked" && (
                    <div className="flex flex-wrap items-baseline gap-x-3 text-[12px] leading-4">
                      <span
                        className="text-muted"
                        title={check.step ? `${stepName(check.step.name)}: ${stepDetail(check.step)}` : "The check did not finish"}
                      >
                        Couldn&apos;t check
                      </span>
                      <button type="button" className={TEXT_BTN} onClick={() => setAttempt((a) => a + 1)}>
                        Check again
                      </button>
                    </div>
                  )}
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
                            {!s.ok &&
                              (isUnreachable(s) ? (
                                <span className="mr-2 font-medium text-foreground">Couldn&apos;t check</span>
                              ) : (
                                <span className="mr-2 font-medium text-bad">Failed</span>
                              ))}
                            <Detail text={stepDetail(s)} />
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
