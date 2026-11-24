import type { Snapshot } from "@/lib/demo/snapshot";

type Attempt = Snapshot["stress"]["attempts"][number];

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const period = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Backend prose is lowercase machine copy ("it asked the broker for x, at $0.262 an hour"); the UI reads it as a sentence. */
function attemptText(what: string): string {
  return sentence(
    what
      .replace(/^it /, "")
      .replace(/, at \$/, " at $")
      .replace(/Vultr desk/gi, "broker")
      .replace(/\bits behaviour score/i, "the limit tester's behaviour score"),
  );
}

/** "/hour" and "/hr" read as "an hour", as everywhere else on the site. */
const hourly = (text: string) => text.replace(/\/(hour|hr)\b/g, " an hour");

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
 * The limit test as a ledger, like the signed exchange on the Run page: "Step N" on the left, then the
 * attempt, the outcome and what it proves behind one 2px ink rule. Stacks under 640px.
 */
export function AttemptLedger({ attempts }: { attempts: Attempt[] }) {
  let step = 0;
  return (
    <div className="space-y-3">
      {attempts.map((a, i) => {
        const o = attemptOutcome(a);
        if (!a.quiet) step += 1;
        return (
          <div key={i} className="grid grid-cols-1 gap-y-1 sm:grid-cols-[88px_minmax(0,1fr)] sm:gap-x-4">
            <div className="text-[12px] leading-5 font-semibold text-foreground">{a.quiet ? "" : `Step ${step}`}</div>
            <div className="min-w-0 border-l-2 border-foreground pl-3 break-words">
              <div className="text-foreground">
                <Prose text={a.quiet ? `Then it ${attemptText(a.what).replace(/^./, (c) => c.toLowerCase())}` : attemptText(a.what)} />
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
              {!a.quiet && <div className="mt-0.5 text-[12px] leading-4 text-muted">{period(sentence(a.proves))}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
