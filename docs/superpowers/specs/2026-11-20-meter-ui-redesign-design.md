# burn402 UI redesign: "the meter"

Date: 2026-11-20. Status: ready for owner approval.

## Intent

burn402 works end to end locally, but the UI reads as an unstyled hackathon tool: an all-monospace page, long explanatory paragraphs under every field, and a pipeline strip of small text. The owner wants it to look professional, and specifically not like an AI-generated template (they rejected generic Stripe-style, Vercel-style dark, and tidied-monospace directions as looking AI-made).

The chosen direction is built from what the product actually is: an agent spending a capped allowance. The money left is the centerpiece, drawn as a gauge that runs down while the rented server burns it.

The page also needs to be split into components now, because the next piece of work (turning the single "Vultr desk" into a broker comparing several providers) will grow the page further.

## Goals

- The main page leads with the budget meter. Before a run it shows the budget you set, during a run it counts down live, and after a run it shows what was spent.
- A consistent look across all three pages (`/`, `/records`, `/audit`): same palette, type and navigation.
- Much less text on screen: short labels, with the current explanations moved into hover details (`title` attributes or a small "?" disclosure) so first-time viewers can still find them.
- `app/page.tsx` split into components with clear responsibilities.
- "Vultr desk" wording replaced with "broker" in the UI (the provider name stays where it is factual, e.g. the plan "Vultr vc2-2c-4gb").

## Non-goals

- No new features and no behavior changes. Every API call, poll, state transition and control that exists today keeps working the same way.
- No backend changes (no changes under `lib/`, `agents/`, `app/api/`).
- No multi-provider broker work yet; that is the next project.
- No dark mode.

## Anti-goals (fails even if it technically works)

- Looking like an AI template: no pill badges, no identical rounded cards with soft shadows, no gradients, no emoji in the UI chrome (the 🔥 in the wordmark goes), no all-caps eyebrow labels, no indigo/violet accent, no arrows appended to button text, no "A · B · C" middle-dot meta strings.
- Breaking the working run flow (job form, negotiation, payment, training, model try-out, stress test).

## Visual system

Palette (replace the tokens in `app/globals.css`; keep token names where the code already uses them, e.g. `--ok`, `--bad`, so components keep working):

| Role | Hex |
| --- | --- |
| Page background (cool gray) | `#E7EAEC` |
| Raised surface (meter panel, inputs) | `#F7F8F9` |
| Ink (text, filled gauge segments, primary button) | `#1B2430` |
| Secondary text | `#5B6672` |
| Rules / empty gauge segments | `#B9C0C7` / `#D5DADF` |
| Amber: money this job will use, and "running low" | `#E3A21A` |
| OK (signed, verified, done) | `#2F6B3F` |
| Bad (errors, refused) | keep current red |

Amber is the only accent and appears only in money-related places.

Colors the old palette had that this one drops (decided): links become ink with an underline (no blue). In the signed exchange, the two sides are told apart by position and label, not hue: your agent's messages in ink with a solid left rule, the broker's in secondary gray with a lighter rule. Progress bars that are not money (training, trust) use ink. The production/mainnet marker on `/records` uses the bad red outline, since writing to mainnet is the permanent, careful choice.

Type: Archivo (Google Fonts, variable width axis) via `next/font/google`, replacing Geist Mono as the main face. Numbers use `font-variant-numeric: tabular-nums`; big amounts use the condensed width (~68%). Monospace (Geist Mono, already loaded) is kept only for real machine strings: signatures, transaction IDs, ANS names, JSON. Type scale: 12/13.5/16/20 for UI, about 40px for the meter amount.

Shape and structure: corners 3 to 6px, varying by importance (the meter panel 6px, inputs and buttons 3px), not one radius everywhere. No drop shadows. Structure comes from spacing, rules and the one raised meter panel, not from cards.

## Layout

Main page:

```
burn402   Run  Records  Audit                     Gemini 3.8 Flash
┌──────────────────────────────────────────────────────────────────┐
│ review-classifier has left                   limit $1.00 an hour │
│ $0.9978 of $1.00                                                 │
│ ████████████████████████████████████████████▌▒░░   (segmented)   │
│ Empty: server shuts down              This job will use $0.0022  │
└──────────────────────────────────────────────────────────────────┘
 Job (left column)            │ Run (right column)
 Agent  review-classifier     │ Stage: deal / payment / training / receipt
 Data   reviews.csv, 400 rows │ Deal: the signed exchange, plan chosen
 Task   Sort reviews…         │ Training progress, then the model try-out
 Budget $1.00  Limit $1.00/h  │ Stress test after a finished run
 [Start run]                  │
```

- The meter spans the full width under the nav. It replaces the current pipeline text strip and the small `BurnMeter`. The stage of the run is shown as a short labelled step row in the run column, not as a separate strip.
- Meter data (decided): payment is one upfront x402 prepay (`job.paidUsd`, set once at `paidAt`); nothing else moves until the run ends. The meter shows:
  - the gauge drops to `budgetUsd − paidUsd` when the payment lands (a real event);
  - the paid portion (amber) then drains live while the server runs, computed on the client as `hourlyUsd of the rented plan × seconds since paidAt / 3600`, capped at `paidUsd`, and labelled as server time used (for example "server time used $0.0011 of $0.0022"). It is derived from the real rate and real elapsed time, never shown as a payment.
  - Animate client-side between 1.5s polls (a 1s tick is fine); stop when the run is done, failed or the lease ends.
- Amber segment (decided): shows the quote for the plan actually rented (`job.plan`, looked up in `job.quotes`), falling back to `job.chosen` before renting. No amber before the first quote arrives.
- Meter states (decided):
  - ready: no current job; full gauge built from the budget and hourly limit being typed in the form. A previous run is not shown on the meter; its summary and model stay in the run column as today.
  - negotiating: full gauge, "your agent is getting quotes"; amber appears once a quote exists.
  - running: the payment drop plus the live drain described above.
  - done: final spent and remaining.
  - failed: gauge frozen, error stated plainly with what to do next.
  - There is no "no budget" state: the form always has a budget (default stays as today).
- The log drawer stays as is functionally and gets the new styling.
- Left-aligned text throughout.
- Nav (decided): links are Run (`/`), Records, Audit. On the right: the model picker / key entry (as today), then Log, then Reset. The "Append conversations to record" checkbox moves out of the nav to sit beside the Start run button, reworded as "Publish my side of the negotiation" with the current explanation as its hover detail; same behavior and same API call.
- Columns (decided): before a run, the job form is the wider left column (as today). Once a run starts, the form collapses to a compact read-only summary (agent, data, task, budget and limit) and the run column becomes the wide one, so the plan comparison table keeps all its columns. When the run ends the form expands again for the next job. The form's inputs are already disabled while running, so no behavior changes.

`/records` and `/audit`: same nav, palette and type; their layouts stay, restyled. No meter on these pages.

Copy: sentence case, plain verbs, no filler. Buttons say what they do ("Start run", "Register agent", "Save key"). Empty and error states say what happened and what to do.

## Component split

Move from one 1,280-line `app/page.tsx` to components under `app/components/` (or `app/_components/`, builder's call). Proposed:

- `Page` (in `app/page.tsx`): owns the polling of `/api/demo/state`, the shared state and the `post` helper; lays out the sections.
- `BudgetMeter`: the hero gauge; pure presentational, takes budget, spent/paid, quoted job cost, hourly limit, state.
- `JobForm`: agent name and registration, training data (files, URL, detected dataset), task, budget/limit/time, plan preference, start button. Owns its own form state; calls back to the page to start a job.
- `RunPanel`: the right column; contains the stage row, `Deal` (negotiation exchange), training progress, `TryIt`, and `StressTest`.
- Existing pieces (`Timeline`, `TryIt`, `StressTest`, `ModelPicker`, `DatasetCard`, `MetricList`, `Fold`) move into their own files, restyled, logic unchanged. `Timeline` can be broken up into the run panel's parts.
- `Nav` already exists in `app/nav.tsx`; restyle it.

State placement: keep shared, server-driven data (`snap`, `job`, trained `models`, `error`) in `Page`. Keep form-only state (request, sources, detected dataset, budget, rate, deadline, preference, agent name) inside `JobForm`, lifting only what the meter needs (the budget and limit being entered, so the meter can show them before a run).

## Approaches considered

- **A. Restyle in place, extract only the new pieces.** Smallest change, least risk to the working flow; leaves a 1,300-line page. Not chosen.
- **B. Split the page into components while redesigning.** Chosen by the owner. Cleaner, and ready for the broker work that will grow the page. Costs a larger change and some risk when moving shared state.
- **C. Colors and fonts only.** Cheapest, but cannot make the meter the centerpiece. Dropped.

## Constraints

- Next.js 16 (Turbopack) with a non-standard setup: read `node_modules/next/dist/docs/` before relying on Next APIs (per the repo's AGENTS.md). Tailwind v4 with tokens in `app/globals.css` via `@theme inline`.
- The app binds to 127.0.0.1 and must keep working with simulated servers and x402 on Solana devnet.
- Uncommitted fixes from setup are on this branch (`lib/ans/cose.ts`, `scripts/register-agents.ts`, `lib/demo/models.ts`, config files); leave them alone.
- Verification: unit tests (`npm test`) and type-check (`npx tsc --noEmit`) pass; a full run in the browser still completes negotiation, payment, training and shows the model; `/records` and `/audit` still load. Check the layout at desktop width and that it does not break at narrow widths.

## Left to the builder

- Exact component file names and folder.
- How hover details are implemented (title attribute vs. small disclosure), as long as they are keyboard-reachable.
- Segment count and animation of the gauge (one subtle transition when the amount changes is fine; no decorative motion).
- Responsive behavior below desktop width (stack the two columns).

## Decisions

The owner asked the designer to choose. These are the designer's calls:

- Meter shows the real payment drop plus a live, labelled drain of the paid amount at the rented plan's hourly rate.
- Explanations become short labels with hover details. Keep the long explanation strings together in one copy module so they can be restored easily.
- "Vultr desk" becomes "broker" in UI copy now.
- The 🔥 emoji leaves the wordmark.
- Records and audit pages get the new look but keep their layouts.
- Nav, column behavior, amber source and dropped colors as described above.
