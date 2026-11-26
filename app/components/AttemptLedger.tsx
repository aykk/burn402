import { moneyText } from "./format";

/** One overspend attempt as the ledger shows it. */
export type Attempt = { what: string; result: string; ok: boolean; blocked: boolean | null; mark: number | null; quiet: boolean; proves: string };

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const period = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Backend prose is lowercase machine copy ("it asked for x, at $0.262 an hour"); the UI reads it as a sentence. */
function attemptText(what: string, exact = false): string {
  const money = exact ? (t: string) => t : moneyText;
  return sentence(money(what.replace(/^it /, "").replace(/, at \$/, " at $")));
}

/**
 * "/hour" and "/hr" read as "an hour", as everywhere else on the site; amounts in the site's money format,
 * unless the text already carries exact amounts (the overspend test's own), which stay as they are.
 */
const hourly = (text: string, exact = false) => {
  const t = text.replace(/\/(hour|hr)\b/g, " an hour");
  return exact ? t : moneyText(t);
};

/**
 * The outcome word and its colour. A blocked attempt is the expected result, so it is ink; only an
 * attempt that got through is red. Results read "refused: …" or "not stopped: …".
 */
export function attemptOutcome(a: Attempt, exact = false): { word: string; reason: string; color: string } {
  const color = a.blocked === false ? "var(--bad)" : "var(--foreground)";
  const word = a.blocked === false ? "Got through" : "Blocked";
  const rest = /^(?:refused|not stopped):?\s*(.*)$/i.exec(a.result)?.[1] ?? a.result;
  return { word, reason: rest ? period(sentence(hourly(rest, exact))) : "", color };
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
 * The overspend test as a ledger: a one-sentence verdict, then "Step N" on the left of every row and the
 * attempt, the outcome and what it proves behind one 2px ink rule. Stacks under 640px.
 */
export function AttemptLedger({ attempts, verdict, exact = false }: { attempts: Attempt[]; verdict: string; exact?: boolean }) {
  return (
    <div className="space-y-4">
      {verdict && <p className="max-w-[64ch] font-semibold text-foreground">{verdict}</p>}
      <ol className="space-y-3">
      {attempts.map((a, i) => {
        const o = attemptOutcome(a, exact);
        return (
          <li key={i} className="grid grid-cols-1 gap-y-1 sm:grid-cols-[88px_minmax(0,1fr)] sm:gap-x-4">
            <div className="text-[12px] leading-5 font-semibold text-foreground">Step {i + 1}</div>
            <div className="min-w-0 border-l-2 border-foreground pl-3 break-words">
              <div className="text-foreground">
                <Prose text={attemptText(a.what, exact)} />
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
