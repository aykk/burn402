# Meter UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle burn402 around a live budget meter and split the 1,280-line `app/page.tsx` into components, with no behavior or backend changes.

**Architecture:** Visual tokens and fonts change once in `app/globals.css` / `app/layout.tsx`, re-skinning every page. Meter numbers come from one pure function (`meterView`) that is unit-tested; the `BudgetMeter` component only renders it. The page keeps server polling and shared state; `JobForm` owns form state; `RunPanel` renders the run.

**Tech Stack:** Next.js 16 (Turbopack, App Router), React 19, Tailwind v4 (`@theme inline` tokens), Vitest 5, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-11-20-meter-ui-redesign-design.md` (read it before every task; it holds the palette, layout sketch, meter rules and anti-goals).

## Global Constraints

- No changes under `lib/`, `agents/`, `app/api/`, `scripts/`, `config/`. Every existing API call, poll (1.5s on `/api/demo/state`), control and state transition keeps working.
- Do not stage or commit these pre-existing uncommitted files: `config/ans/tl-root-keys.txt`, `config/trust-index/runtime.yaml`, `lib/ans/ans.test.ts`, `lib/ans/cose.ts`, `lib/demo/models.ts`, `package.json`, `package-lock.json`, `scripts/register-agents.ts`, `AGENTS.md`, `CLAUDE.md`. Always `git add` explicit paths. Commit messages end with the two attribution lines: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01PWr147KRJakGphvHbpbSeM`. Never push.
- Read the relevant guide in `node_modules/next/dist/docs/` before using a Next.js API (repo AGENTS.md rule).
- Palette (exact): background `#E7EAEC`, surface `#F7F8F9`, ink `#1B2430`, secondary `#5B6672`, rule `#B9C0C7`, empty segment `#D5DADF`, amber `#E3A21A` (money only), ok `#2F6B3F`, bad keeps `#cf222e`.
- Type: Archivo via `next/font/google` (variable, include the `wdth` axis) as the main face; `tabular-nums` on all amounts; meter amount about 40px at ~68% width. Geist Mono only for machine strings (signatures, tx ids, ANS names, JSON).
- Anti-goals: no pill badges, no identical rounded shadowed cards, no gradients, no emoji in UI chrome, no all-caps labels, no indigo/violet, no arrows appended to button text, no "A · B · C" middle-dot strings, no drop shadows. Radius 6px for the meter panel, 3px for inputs and buttons.
- Copy: sentence case, plain verbs. "Vultr desk" becomes "broker" in UI text. Buttons: "Start run", "Register agent", "Save key".
- The dev server is already running on http://127.0.0.1:3000 with a Gemini key held in server memory. Do not restart it (a restart loses the key; if one is unavoidable, stop and report).
- Every task ends with `npm test` and `npx tsc --noEmit -p .` passing.

## Review Focus

1. A run that fails during negotiation (no quotes, `paidUsd` null): meter shows "failed" with the error and what to do, no amber, no NaN.
2. The agent rents a plan the broker did not recommend (`job.plan` differs from `job.chosen.plan`, or is missing from `job.quotes`): amber and drain use the rented plan, falling back to `chosen`, never NaN.
3. `/api/demo/state` becomes unreachable mid-session: the page still renders, the meter keeps its last numbers and the error line says how to fix it.
4. Narrow screens (390px wide): columns stack, the meter amount stays readable, nothing overflows horizontally.
5. A finished previous run with no current job: meter shows "ready" from the form values; the previous model still shows in the run column.

Items 1 and 2 are pinned by unit tests in Task 2; items 3 to 5 are explicit checks in Task 7.

---

### Task 1: Visual foundation (tokens, font, copy module)

**Files:**
- Modify: `app/globals.css` (token values in `:root`, base styles)
- Modify: `app/layout.tsx` (fonts)
- Create: `app/components/copy.ts`

**Interfaces:**
- Produces: CSS tokens keep their existing names (`--background`, `--foreground`, `--muted`, `--rule`, `--rule-strong`, `--surface`, `--charcoal`, `--ok`, `--bad`) with new values, plus new `--amber` (`#E3A21A`) and `--segment` (`#D5DADF`) exposed as Tailwind colors `amber` and `segment`. `--paid`, `--warn`, `--mark`, `--burn` are remapped per the spec's "colors dropped" paragraph (links and "your agent" to ink, broker side to secondary, non-money bars to ink).
- Produces: `--font-sans` is Archivo; `--font-mono` stays Geist Mono. Body uses `--font-sans`.
- Produces: `copy.ts` exports `const HELP: Record<string, string>` holding the long explanation strings currently written inline in `app/page.tsx` (agent, training data, task, budget, hourly cap, time limit, plan preference, publish-my-side checkbox, nothing-trained-yet), keyed by short names (`agent`, `data`, `task`, `budget`, `rate`, `deadline`, `preference`, `publish`, `empty`). Text copied verbatim except "Vultr desk" becomes "broker".

- [ ] **Step 1:** Update tokens and base styles in `app/globals.css` to the palette above; links become ink with underline; inputs get `--surface` background, 3px radius, `--rule` border.
- [ ] **Step 2:** In `app/layout.tsx`, load Archivo with the width axis and set its variable as `--font-sans`; keep Geist Mono as `--font-mono`; drop Geist Sans if unused.
- [ ] **Step 3:** Create `app/components/copy.ts` with `HELP` as specified.
- [ ] **Step 4:** Run `npm test` and `npx tsc --noEmit -p .`. Expected: 258 passed, tsc exit 0.
- [ ] **Step 5:** Load http://127.0.0.1:3000, `/records`, `/audit` and confirm each returns 200 and renders in Archivo on the gray background (screenshot).
- [ ] **Step 6:** Commit `app/globals.css app/layout.tsx app/components/copy.ts` as `style: meter palette and Archivo type`.

### Task 2: Meter model (pure logic, TDD)

**Files:**
- Create: `app/components/meter-model.ts`
- Test: `app/components/meter-model.test.ts`

**Interfaces:**
- Consumes: `TrainingRunView`, `JobPhase` from `@/lib/demo/train`; `PlanQuote` from `@/lib/train`.
- Produces:

```ts
export type MeterPhase = "ready" | "negotiating" | "running" | "done" | "failed";
export type MeterJob = Pick<TrainingRunView, "phase" | "budgetUsd" | "rateUsdHr" | "quotes" | "chosen" | "plan" | "paidUsd" | "paidAt" | "doneAt" | "error">;
export type MeterView = {
  phase: MeterPhase;
  budgetUsd: number;
  rateUsdHr: number;
  remainingUsd: number;      // budget minus paid (budget when nothing paid)
  quotedUsd: number | null;  // job cost of the rented plan, else chosen, else null
  paidUsd: number | null;
  burnedUsd: number | null;  // server time used, capped at paidUsd
  error: string | null;
};
export function meterView(input: { formBudgetUsd: number; formRateUsdHr: number; job: MeterJob | null; nowSec: number }): MeterView;
```

Rules (from the spec): no job → `ready` from form values. `negotiating` → full budget, quoted once a quote exists. `paying|booting|training|publishing` → `running`; after payment, remaining = budget − paid and burned = min(paid, rentedHourlyUsd × (min(now, doneAt ?? now) − paidAt) / 3600). `done` and `failed` freeze at `doneAt ?? now`; `failed` carries `job.error`. Rented quote = `quotes.find(q => q.plan === job.plan) ?? chosen`. All timestamps are seconds. Never return NaN: missing `paidAt` gives burned 0; missing quote gives quoted null and burned null.

- [ ] **Step 1: Write the failing tests** in `app/components/meter-model.test.ts` using a quote helper `q(plan, hourlyUsd, jobUsd)`:
  - `ready with no job`: formBudget 1, formRate 1 → `{ phase: "ready", budgetUsd: 1, remainingUsd: 1, quotedUsd: null, burnedUsd: null }`.
  - `negotiating before a quote`: quotes [] chosen null → phase `negotiating`, remaining 1, quotedUsd null.
  - `negotiating with a quote`: chosen `q("vc2-2c-4gb", 0.027, 0.0022)` → quotedUsd 0.0022.
  - `running drains at the rented plan's rate`: phase `training`, plan `vc2-2c-4gb`, quotes [q("vc2-1c-1gb",0.007,0.0006), q("vc2-2c-4gb",0.027,0.0022)], paidUsd 0.0022, paidAt 1000, now 1160 → remainingUsd ≈ 0.9978, burnedUsd ≈ 0.0012 (toBeCloseTo, 6).
  - `drain is capped at what was paid`: same, now 1000 + 3600 → burnedUsd 0.0022.
  - `rented plan missing from quotes falls back to chosen` (Review Focus 2): plan `vc2-4c-8gb`, quotes without it, chosen q("vc2-2c-4gb",0.027,0.0022) → quotedUsd 0.0022, burned uses 0.027.
  - `failed during negotiation shows the error and no amber` (Review Focus 1): phase `failed`, quotes [], chosen null, paidUsd null, error "your agent finished without renting a server" → phase `failed`, remainingUsd 1, quotedUsd null, burnedUsd null, error equal.
  - `done freezes at doneAt`: paidAt 1000, doneAt 1100, now 5000, hourly 0.027 → burned ≈ 0.00075.
  - `no NaN when paidAt is missing`: running, paidUsd 0.0022, paidAt null → burnedUsd 0.
- [ ] **Step 2:** Run `npx vitest run app/components/meter-model.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `meterView` in `app/components/meter-model.ts` per the rules.
- [ ] **Step 4:** Run the same command. Expected: all pass. Then `npm test` (267 passed) and `npx tsc --noEmit -p .`.
- [ ] **Step 5:** Commit both files as `feat: meter model with live drain`.

### Task 3: BudgetMeter component

**Files:**
- Create: `app/components/BudgetMeter.tsx`

**Interfaces:**
- Consumes: `meterView`, `MeterView`, `MeterJob` (Task 2).
- Produces: `export function BudgetMeter(props: { agentName: string | null; formBudgetUsd: number; formRateUsdHr: number; job: MeterJob | null; nowSec: number }): JSX.Element` (client component).

- [ ] **Step 1:** Build the full-width raised panel from the spec sketch: header row ("{agent} has left", "limit $X an hour"), amount (`remainingUsd`, 4 decimals, condensed ~40px) with "of $budget", a segmented gauge (builder picks segment count, about 40) where filled = remaining share in ink, the quoted/paid share in amber, the rest `segment`; footer row "Empty: server shuts down" and, depending on phase, "This job will use $X", "Server time used $burned of $paid", "Spent $paid", or the error with a next step for `failed`. Use `HELP` keys for hover details where useful.
- [ ] **Step 2:** Drive `nowSec` from the parent (Task 6 adds a 1s tick); the component itself holds no timers. One subtle width transition on the gauge is allowed; respect `prefers-reduced-motion`.
- [ ] **Step 3:** Run `npx tsc --noEmit -p .` (exit 0).
- [ ] **Step 4:** Commit as `feat: BudgetMeter component`.

### Task 4: Move existing pieces out of page.tsx (no behavior change)

**Files:**
- Create: `app/components/format.ts` (move `clock`, `duration`, `money`, `size`, `kb`, `REGIONS`, `PHASE_TEXT`, `toneOf`, `collapseLog` unchanged)
- Create: `app/components/DatasetCard.tsx`, `MetricList.tsx`, `Fold.tsx`, `TryIt.tsx`, `StressTest.tsx`, `ModelPicker.tsx`, `Timeline.tsx`, `LogDrawer.tsx` (each moved unchanged, then restyled to the new tokens)
- Modify: `app/page.tsx` (imports instead of local definitions)

**Interfaces:**
- Produces: each component keeps its current props signature exactly as in today's `app/page.tsx` (for example `Timeline({ job, model, snap, post })`, `TryIt({ title, job, model, models })`, `StressTest({ snap, post })`, `ModelPicker({ models, disabled, onSave })`). `LogDrawer({ open, onClose, log }: { open: boolean; onClose: () => void; log: Snapshot["log"] })` wraps the existing drawer markup, keeping the auto-scroll.
- `BurnMeter` and `Pipeline` are not moved; they are deleted in Task 6.

- [ ] **Step 1:** Move the code with no logic edits; `app/page.tsx` imports them. Run `npx tsc --noEmit -p .` and load `/` (200, page looks as before apart from Task 1 styling).
- [ ] **Step 2:** Restyle each moved component to the tokens and anti-goals (remove rounded-card + shadow treatments, middle-dot strings, emoji; "Vultr desk" to "broker"; your-agent vs broker messages per the spec's dropped-colors rule).
- [ ] **Step 3:** `npm test`, `npx tsc --noEmit -p .`, load `/`.
- [ ] **Step 4:** Commit the new files and `app/page.tsx` as `refactor: split page components`.

### Task 5: JobForm component

**Files:**
- Create: `app/components/JobForm.tsx`
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `HELP` (Task 1), `DatasetCard` (Task 4), `Snapshot` type.
- Produces:

```ts
export type JobDraft = { budgetUsd: number; rateUsdHr: number };
export function JobForm(props: {
  snap: Snapshot | null;
  running: boolean;
  collapsed: boolean;                       // true while a run is in progress
  onDraftChange: (draft: JobDraft) => void; // budget/limit as typed, for the meter
  onStart: (body: { request: string; dataset: DatasetSource; budgetUsd: number; rateUsdHr: number; deadlineMinutes: number; preference: number }) => Promise<void>;
  reload: () => Promise<void>;              // the page's load()
}): JSX.Element;
```

- [ ] **Step 1:** Move all form state and handlers from `Page` into `JobForm` unchanged (agent name and `/api/demo/identity`, sources, detected dataset, drag/drop, URL add, remove, request, budget default 5, rate 1.25, deadline 30, preference 0.5). `onStart` is called with the same body the page posts to `/api/demo/job` today.
- [ ] **Step 2:** Lay it out with short labels and `HELP` hover details (`title` plus a keyboard-focusable "?" control), the readiness hints as today, the "Publish my side of the negotiation" checkbox next to Start run calling `/api/demo/network` exactly as the nav checkbox does now.
- [ ] **Step 3:** When `collapsed`, render a compact read-only summary (agent, data, task, budget and limit) instead of the inputs.
- [ ] **Step 4:** `npx tsc --noEmit -p .`; in the browser, register an agent, add `reviews.csv` and confirm the dataset is detected (400 rows, 2 labels) exactly as before.
- [ ] **Step 5:** Commit as `feat: JobForm component`.

### Task 6: Page composition, RunPanel and nav

**Files:**
- Create: `app/components/RunPanel.tsx`
- Modify: `app/page.tsx`, `app/nav.tsx`

**Interfaces:**
- Consumes: `BudgetMeter` (Task 3), `JobForm`/`JobDraft` (Task 5), `Timeline`, `TryIt`, `StressTest`, `LogDrawer`, `ModelPicker` (Task 4).
- Produces: `RunPanel({ snap, job, current, previous, previousModel, post }: { snap: Snapshot | null; job: TrainingRunView | null; current: TrainedModel | null; previous: TrainingRunView | null; previousModel: TrainedModel | null; post: (path: string, body?: unknown) => Promise<void> })`.

- [ ] **Step 1:** `RunPanel` shows a short labelled stage row (deal, payment, training, receipt, derived from `job.phase`), then the existing `Timeline` content, then `TryIt` (current model, else the previous run's model, else the empty state from `HELP.empty`), then `StressTest` after a done run, as today.
- [ ] **Step 2:** `Page` renders: nav, `BudgetMeter` (full width), then two columns. Before a run: `JobForm` wide left, `RunPanel` right. During a run (`running`): `JobForm collapsed` narrow left, `RunPanel` wide right. Below 1024px the columns stack. Add a 1s `nowSec` tick (client clock aligned to `snap.now` on each poll) only while `running`. Delete `Pipeline` and `BurnMeter`.
- [ ] **Step 3:** `app/nav.tsx`: wordmark "burn402" without emoji; links Run (`/`), Records, Audit with the current page marked; right side keeps the model picker, Log (opens `LogDrawer`), Reset (same handler as today).
- [ ] **Step 4:** `npm test`, `npx tsc --noEmit -p .`, load `/` (200).
- [ ] **Step 5:** Commit as `feat: meter-led page layout and nav`.

### Task 7: Records and audit restyle, then the visual review loop

**Files:**
- Modify: `app/records/page.tsx`, `app/audit/page.tsx`, any component above as review finds issues

- [ ] **Step 1:** Restyle `/records` and `/audit` to the tokens, keeping their layouts and behavior; mainnet marker uses the bad red outline.
- [ ] **Step 2:** Run a full job in the browser (agent `review-classifier`, `reviews.csv` from `<scratch folder>/burn/reviews.csv`, task "Train a classifier that labels product reviews as positive or negative.", budget 1, limit 1, 30 min, balanced). Screenshot at 1440px wide in each meter state: ready, negotiating, running (watch the drain move), done. The Gemini negotiation takes several minutes.
- [ ] **Step 3:** Review-focus checks: (3) without stopping the server, make the state fetch fail in the browser (for example run `window.fetch = () => Promise.reject(new Error("offline"))` in the page via the browser tool) and confirm the error line renders and the meter keeps its numbers, then reload; (4) screenshot at 390px wide, confirm stacking and no horizontal scroll; (5) after the run, reload with no new job and confirm meter "ready" and the previous model visible.
- [ ] **Step 4:** Compare every screenshot against the spec's anti-goals list and palette; fix what fails; repeat Steps 2 to 4 until a fresh reviewer finds no anti-goal violations and the layout matches the spec sketch.
- [ ] **Step 5:** `npm test`, `npx tsc --noEmit -p .`; commit as `style: records and audit, review fixes`.
