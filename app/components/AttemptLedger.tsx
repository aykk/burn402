import type { Snapshot } from "@/lib/demo/snapshot";
import { moneyText } from "./format";

type Attempt = Snapshot["stress"]["attempts"][number];
type Status = Snapshot["stress"]["status"];

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const period = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Backend prose is lowercase machine copy ("it asked the broker for x, at $0.262 an hour"); the UI reads it as a sentence. */
function attemptText(what: string): string {
  return sentence(
    moneyText(
      what
        .replace(/^it /, "")
        .replace(/, at \$/, " at $")
        .replace(/Vultr desk/gi, "broker")
        .replace(/\bits behaviour score/i, "the second agent's behaviour score"),
    ),
  );
}

/** "/hour" and "/hr" read as "an hour", as everywhere else on the site; amounts in the site's money format. */
const hourly = (text: string) => moneyText(text.replace(/\/(hour|hr)\b/g, " an hour"));

/** A backend message about the test (an error) in the UI's words: one name for the feature, site money, a sentence. */
export function testCopy(text: string): string {
  return period(sentence(moneyText(text.trim().replace(/\bstress test(er)?\b/gi, (_, er?: string) => (er ? "second agent" : "overspend test")))));
}

/** An attempt the broker never saw: the second agent went around it with its own provider key. */
const wentAround = (a: Attempt) => a.blocked === false && (a.quiet || /around the broker/i.test(a.what));

/**
 * The test in one sentence, from the attempts themselves: "3 attempts: 2 blocked by the broker, 1 went
 * around it and the auditor caught it." Only the second agent's attempts count (blocked is set); the
 * auditor's steps decide the ending. Null before the first attempt.
 */
export function attemptVerdict(attempts: Attempt[], status: Status): string | null {
  const tries = attempts.filter((a) => a.blocked !== null);
  if (tries.length === 0) return null;
  const blocked = tries.filter((a) => a.blocked === true).length;
  const around = tries.filter(wentAround).length;
  const past = tries.length - blocked - around;
  const through = around + past;
  const caught = attempts.some((a) => a.blocked === null && a.ok && /^caught it/i.test(a.result));
  const count = `${tries.length} attempt${tries.length === 1 ? "" : "s"}${status === "running" ? " so far" : ""}`;
  if (through === 0) return tries.length === 1 ? `${count}: blocked by the broker.` : `${count}, all blocked by the broker.`;

  const clauses: string[] = [];
  let broker = "the broker";
  if (blocked > 0) {
    clauses.push(`${blocked} blocked by ${broker}`);
    broker = "it";
  }
  if (around > 0) {
    clauses.push(`${around} went around ${broker}`);
    broker = "it";
  }
  if (past > 0) clauses.push(`${past} got past ${broker}`);
  const them = through === 1 ? "it" : "them";
  const ending = caught ? ` and the auditor caught ${them}` : status === "done" ? ` and the auditor did not catch ${them}` : "";
  return `${count}: ${clauses.join(", ")}${ending}.`;
}

/**
 * The outcome word and its colour. The backend strings stay as they are; the rewrite happens here, as
 * `outcomeLabel()` does on /records. Blocked by the broker is the expected result, so it is ink (as
 * "Refused by the broker" is on /records); only an attempt that got through is red.
 */
export function attemptOutcome(a: Attempt): { word: string; reason: string; color: string } {
  // The trust-index step: a score change, not a listing.
  if (/^the trust index/i.test(a.what) || /→/.test(a.result)) {
    const dir = /\b(lowered|raised)\b/i.exec(a.what)?.[1].toLowerCase();
    const word = dir ? `Score ${dir}` : "Score kept";
    const m = /^(.*?)\s*,?\s*from (\d+) anchored violation\(s\)(.*)$/i.exec(a.result);
    const reason = m
      ? `Behaviour score ${m[1].trim()}, from ${m[2]} anchored violation${m[2] === "1" ? "" : "s"}${m[3]}.`
      : period(`Behaviour score ${a.result}`);
    return { word, reason, color: a.ok ? "var(--ok)" : "var(--foreground)" };
  }
  const color = a.blocked === true ? "var(--foreground)" : a.blocked === false ? "var(--bad)" : a.ok ? "var(--ok)" : "var(--bad)";
  const split = /^(refused|not stopped|caught it|unexpected):?\s*(.*)$/i.exec(a.result);
  if (split) {
    const head = split[1].toLowerCase();
    const word = head === "refused" ? "Blocked" : head === "caught it" ? "Caught it" : "Got through";
    const rest = head === "unexpected" ? `The broker answered ${split[2] || "something else"}` : split[2];
    return { word, reason: rest ? period(sentence(hourly(rest))) : "", color };
  }
  // The auditor's own listing: a count, then any instances with no receipt.
  const word = a.blocked === true ? "Blocked" : a.blocked === false ? "Got through" : a.ok ? "Found it" : "Missed it";
  return { word, reason: period(sentence(hourly(a.result))), color };
}

/** ANS names inside the prose render in mono and may break anywhere; the prose itself only breaks at spaces. */
function Prose({ text }: { text: string }) {
  const parts = text.split(/(ans:\/\/[^\s,;]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.burn402\.xyz)/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-mono text-[12px] [overflow-wrap:anywhere]">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * The overspend test as a ledger, like the signed exchange on the Run page: a one-sentence verdict, then
 * "Step N" on the left of every row (the attempt that went around the broker included) and the attempt,
 * the outcome and what it proves behind one 2px ink rule. Stacks under 640px.
 */
export function AttemptLedger({ attempts, status, verdict: given }: { attempts: Attempt[]; status: Status; verdict?: string }) {
  // a caller with its own verdict (the purchasing agent's overspend test) passes it in
  const verdict = given ?? attemptVerdict(attempts, status);
  return (
    <div className="space-y-4">
      {verdict && <p className="max-w-[64ch] font-semibold text-foreground">{verdict}</p>}
      <ol className="space-y-3">
      {attempts.map((a, i) => {
        const o = attemptOutcome(a);
        return (
          <li key={i} className="grid grid-cols-1 gap-y-1 sm:grid-cols-[88px_minmax(0,1fr)] sm:gap-x-4">
            <div className="text-[12px] leading-5 font-semibold text-foreground">Step {i + 1}</div>
            <div className="min-w-0 border-l-2 border-foreground pl-3 break-words">
              <div className="text-foreground">
                <Prose text={attemptText(a.what)} />
              </div>
              <div>
                <span className="font-semibold" style={{ color: o.color }}>
                  {o.word}.
                </span>
                {o.reason && (
                  <span className="text-muted">
                    {" "}
                    <Prose text={o.reason} />
                  </span>
                )}
              </div>
              {a.proves && <div className="mt-0.5 text-[12px] leading-4 text-muted">{period(sentence(a.proves))}</div>}
            </div>
          </li>
        );
      })}
      </ol>
    </div>
  );
}
