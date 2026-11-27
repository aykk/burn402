# burn402 pivot: a purchasing agent that rents compute over x402

Date: 2026-11-24. Status: approved by the owner in conversation ("do b", then "yes start and if you have any improvement add them"). Branch: `x402-market` (from `ui-meter-redesign`). Local only: never push.

## Intent

Today burn402's agent "negotiates" with a broker that is the team's own code, then trains a model on a simulated server. Compute prices are posted prices, so there is nothing to haggle over, and no outside party is involved.

The pivot: the agent becomes a **purchasing agent with a spending limit**. The owner states what compute is needed and the limits. The agent goes out to real x402 compute sellers, finds the best rate, pays with x402 and rents a machine. Model training and the negotiation chat leave the main flow.

Done means: a real machine is rented from a real outside seller, paid over x402, and then destroyed.

## What was found (facts the design rests on)

- **x402layer / Singularity Compute** (`https://compute.x402layer.cc`) is the one usable x402 seller. Verified live on 2026-11-24:
  - `GET /compute/plans` (no auth) returns `{ plans, markup_multiplier, cache_age_seconds, hourly }`. 148 plans: `provider` is `vultr` (98), `digitalocean` (42) or `runpod` (8). Plan fields: `id, type, vcpu_count, ram` (MB)`, disk, locations[], gpu_type, gpu_vram_gb, vultr_monthly, vultr_hourly, our_monthly, our_hourly, in_stock`.
  - `hourly` block: `{ enabled, min_hours, min_hours_by_kind: { machine: 1, gpu: 2 }, surcharge_below_hours: 24, surcharge_pct: { machine: 15, gpu: 20 } }`.
  - An unpaid `POST /compute/provision` with `{ plan, region, os_id, label, prepaid_hours, ssh_public_key, network: "solana", max_total_usd }` returns HTTP 402 with a `PAYMENT-REQUIRED` header (x402 v2, base64 JSON): `accepts[0] = { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" (USDC), amount: "10000", payTo, maxTimeoutSeconds, extra.feePayer }`. For `vc2-1c-1gb`, 1 hour, that is $0.010000. The seller pays the Solana fee, so the buyer needs USDC only.
  - The quoted amount ($0.0100) differs slightly from the list arithmetic ($0.009027 × 1.15 = $0.0104). **The 402 quote is the truth; the price list is an estimate.**
  - Paid retry: resend the same request with `PAYMENT-SIGNATURE`. Success (200/201): `{ success, order: { id, plan, region, status, ip_address, expires_at, vultr_instance_id }, tx_hash }`. `202` = paid, delivery still being confirmed (body holds the order). `409` with code `settlement_pending` = payment outcome unknown; **do not pay again**. `409` with `quote_usd` = price above `max_total_usd`; nothing charged.
  - Management (`GET /compute/instances/:id`, `GET /compute/instances`, `DELETE /compute/instances/:id`) needs the paying wallet's signature. Headers: `X-Auth-Address` (base58 pubkey), `X-Auth-Chain: solana`, `X-Auth-Signature` (base64 ed25519 signature), `X-Auth-Timestamp` (epoch ms), `X-Auth-Nonce` (32 hex chars), `X-Auth-Sig-Encoding: base64`. Signed message, lines joined with `\n`, no trailing newline: `X402-COMPUTE-AUTH`, `v1`, `solana`, address, METHOD, path, sha256-hex of the exact body string (of `""` when there is no body), timestamp, nonce. Do not send `X-Auth-*` on the paid provision request. This template comes from the seller's open-source client code, not its docs, so it must be confirmed against the live `GET /compute/instances` (a signed read, free).
  - Real USDC on Solana mainnet only. No test mode. Machines: 1 hour minimum (GPUs 2). No stated refund for destroying early.
  - `os_id` 2284 = Ubuntu 24.04 on Vultr. DigitalOcean uses string slugs (e.g. `ubuntu-24-04-x64`), listed at `GET /compute/os` as `{ os: [{ id, name, family, provider }] }`. Regions at `GET /compute/regions` as `{ regions: [{ id, city, provider }] }`.
- **nuza** (`https://nuza.io`): per-second GPU spot market with a Solana x402 rail, but 0 machines online. `GET /api/v1/pricing` returns `{ gpus: [] }` today. Read-only use.
- The repo's existing `payingFetch` (`lib/x402/client.ts`) registers the exact-SVM scheme for `solana:*`, and `X402Processor` (`lib/x402/processor.ts`) can verify and settle payments on devnet. Both are reused.

## Goals

1. **Right-size.** From a stated need (CPU or GPU, vCPUs, RAM, GPU memory, hours), pick the smallest plan that fits, counting minimum hours and short-rental surcharges in the true total.
2. **Compare.** Rank every fitting plan across the seller's providers (Vultr, DigitalOcean, RunPod) and show the provider's own list price next to the seller's price, so the markup is visible. Then ask the seller for **firm quotes** (free, unpaid 402) on the top candidates and re-rank on the real numbers.
3. **Spot.** Read nuza's spot feed. Spot offers enter the ranking only if the owner allows interruptible machines, and never above the hourly limit. Renting from nuza is not built (nothing is online); the UI says so plainly.
4. **Fallback.** If a plan is out of stock, a quote fails or a rental fails *before any payment was sent*, try the next region, then the next plan, then the next provider. After a payment is sent, never start a second purchase for the same run.
5. **Cannot overspend.** A guard checks every payment request before signing. Signed, recorded purchase decisions. Automatic destroy.

Plus a working rental: SSH key generated per rental, IP shown, a check that the machine answers on port 22, a "Destroy now" button, and a sweep script.

## Non-goals

- No model training, datasets, negotiation chat or model try-out in the flow. Their code stays in the repo untouched (`lib/train`, `agents/`), but the main page no longer uses it.
- No renting from nuza, no direct Vultr/Vast/RunPod accounts.
- No refunds logic beyond showing what the seller reports.
- No mobile-specific layout work beyond not breaking at 390px.

## Anti-goals (fails even if it works)

- **Paying twice** for one run, or paying anything the owner did not approve.
- **Any agent or automated test sending a mainnet payment.** Only the owner pressing the pay button in the UI may do that.
- Printing or committing wallet keys, SSH private keys or API keys.
- Leaving a paid machine running with no record of it (lost instance ID).
- Showing an estimate as if it were the price paid.

## Design

### Sellers

A `Seller` interface with two implementations that speak **the same wire protocol**:

- `x402layer` — the real seller. Mainnet. Wallet from `MAINNET_SOLANA_SECRET_KEY` / `MAINNET_SOLANA_ADDRESS` in `.env.local` (a throwaway wallet; absent until the owner sets it up). Without it the seller is still scanned and quoted, and the pay step says a mainnet wallet is needed.
- `test seller` — served by this app under `/api/testseller/compute/*`. Same endpoints, same 402 header, same `X-Auth-*` checks. Payments are **really settled on Solana devnet** through the existing `X402Processor` to `SOLANA_RECEIVER_ADDRESS`; machines are simulated (an in-memory instance with a fake IP from TEST-NET-3, `203.0.113.x`). Its catalog is a trimmed, committed snapshot of the real plans feed. It has fault switches for tests: out-of-stock region, price raised between list and quote, wrong asset in the 402, first paid attempt answers 5xx, 202 pending, 409 `settlement_pending`. It is labelled "Test seller (devnet, simulated machines)" everywhere.

The owner picks the market in the form: **Test (devnet)** or **Real (mainnet)**. Default is Test.

### The run

One run goes through: `scanning → choosing → quoting → approval → paying → provisioning → ready → releasing → released`, or `failed` / `refused`.

- **scanning**: fetch the plan list (and nuza's feed for the real market). Feed failures are reported per source and do not stop the run if another source answered.
- **choosing**: pure code. Filter to plans that fit the need and are in stock in an allowed region; compute the estimated total; drop anything over the limits, keeping the reason; rank by estimated total, then smaller machine first.
- **quoting**: send the unpaid provision request for up to the top 3 candidates and read the real amounts. Re-rank by quoted amount. Quotes that fail move down with their reason.
- **approval**: the run stops and shows exactly what will be paid: amount, token, network, recipient address, plan, hours. On mainnet this stop is mandatory. On the test market it is skipped unless "Ask me before paying" is ticked (default: ticked).
- **paying / provisioning**: sign and send the payment for the approved quote only, then poll the instance until it has an IP, then check port 22 (skipped for the test seller's fake IPs).
- **ready**: shows IP, the SSH command, time left. Destroys automatically at the earlier of the owner's requested hours and the paid expiry, or on "Destroy now".
- **released**: destroyed and confirmed gone from the seller's instance list.

### The guard (point 5)

Before any signature, the guard checks the decoded payment requirements against the run's limits and refuses with a named reason:

| Check | Refusal |
| --- | --- |
| scheme is `exact`, network is the market's expected network | `WRONG_NETWORK` |
| asset is the official USDC mint for that network | `WRONG_ASSET` |
| amount ≤ the amount the owner approved (or, on auto-pay, ≤ the firm quote) | `OVER_QUOTE` |
| amount ≤ budget left for this run | `OVER_BUDGET` |
| amount ÷ prepaid hours ≤ hourly limit | `OVER_RATE` |
| this run has not already sent a payment | `ALREADY_PAID` |

The limits come from a signed mandate (owner → agent), made the same way `TrainingRun` makes its mandate today, so the existing identity and mandate code stays the source of truth. `max_total_usd` is also sent to the seller as a second line of defense.

The x402 client must not be allowed to pay "whatever the 402 says". The paying step decodes the 402 itself, runs the guard, and only then builds the payment for those exact requirements.

### Never pay twice, never lose a machine

- A purchase journal on disk at `.burn402/purchases.jsonl` (already gitignored). An `intent` line is written **before** the payment is sent; `paid`, `active`, `released` and `failed` lines follow. It holds no secrets.
- After a timeout, 5xx, 202 or 409 `settlement_pending` on the paid request, the run does not sign again. It polls the seller's instance list for the order and either adopts the instance or reports "payment outcome unknown" with the transaction details.
- On startup, journal entries that were paid but not released are shown as "machines that may still be running", with a destroy button.
- `npm run market:sweep` lists and destroys every instance the wallet owns on a chosen market. Destroying on mainnet from the script requires an explicit `--yes-destroy` flag.

### Mainnet payment needs a person

- The pay endpoint requires a one-time approval code that is issued with the quote and shown only in the page's state. Without the matching code the server refuses. This also stops another website from triggering a payment with a blind request to localhost.
- Mainnet runs always stop at approval. There is no setting that auto-pays on mainnet.
- Agents building this, and all automated tests, never call the pay endpoint for the mainnet market. Live tests against the real seller are limited to `GET` and unpaid 402 quotes, behind `BURN402_LIVE_MARKET=1`.

### Records

Each purchase decision (accepted, refused by the guard, failed) is written as a signed record using the existing `TransactionRecord` + `anchorTransaction` path, signed by the buying agent's key, with the Solana transaction and the mandate ID. Arweave default becomes **testnet** for this branch (`BURN402_ARWEAVE_NETWORK=testnet` in `.env.local`), and the misleading startup log line is corrected to print the real network. If anchoring fails the run still completes and the record shows "not anchored" with the reason.

### Plain-English needs (optional, uses the model key)

A text box "Describe what you need" fills the form fields through the existing LLM helper (`lib/demo/llm.ts`). The model never chooses the plan or touches payment. Without a model key the box is disabled with the reason, and the form works by hand. **The whole flow runs with no model key.**

### UI

Keep the meter design system as is (tokens, Archivo, 🔥 wordmark, no pills/cards/gradients/eyebrows/middle dots).

```
🔥 burn402   Rent  Records  Overspend test                 Log  Reset
Give an agent a budget and it rents the compute for you.
┌───────────────────────────────────────────────────────────────────┐
│ Budget left for review-classifier              Limit $0.05 an hour │
│ $1.00  of $1.00   ████████████████████████████████████▒           │
│ $0, machine is destroyed                   This rental: $0.0100   │
└───────────────────────────────────────────────────────────────────┘
 What you need                │ Scan  Choose  Pay  Machine
 Market   [Test] [Real]       │ 148 plans from 3 providers, 0 spot offers
 Kind     [CPU] [GPU]         │ Plan            Provider  List    Seller  Quote
 vCPUs 1  RAM 1 GB  Hours 1   │ vc2-1c-1gb ewr  Vultr     $0.0069 $0.0090 $0.0100  chosen
 Budget $1  Limit $0.05/h     │ do:s-1vcpu-1gb  DO        …       $0.0116 $0.0134
 [ ] Interruptible is OK      │ vhp-1c-1gb-amd  Vultr     …       not asked
 [x] Ask me before paying     │ 31 plans left out: 22 too small, 9 over your hourly limit
 [Find and rent]              │ Pay $0.0100 USDC to ELT2…d5Ux on Solana mainnet  [Pay and rent]
```

- Meter: before payment, amber = the firm quote. After payment, the paid amount drains over the rented time (prepaid, so it is labelled "time used", not money moving). At release it shows what was spent.
- Right column: stage row, the comparison table (list price, seller price, firm quote, why chosen or left out), the approval line, then the machine block (IP, SSH command with copy, port-22 check, time left, Destroy now, Solscan link).
- `/audit` becomes the overspend test for the purchasing agent, run against the test seller only: over the hourly limit, over the budget, seller raises the price after quoting, seller asks for the wrong token, a second payment for the same run. Each attempt is listed as blocked or not, reusing `AttemptLedger`.
- `/records` keeps working and lists the purchase records.

## Approaches considered

- **A. Our own broker rents with provider API keys, agent pays our broker in devnet USDC.** Cheap and fully testable, but the x402 payment stays inside our own system. Not chosen by the owner.
- **B. Pay an x402-native seller directly.** Chosen. Real outside counterparty and real x402 purchase. Costs: mainnet money, one early-stage seller, and a person must press pay.
- **B without a test seller.** Rejected: nothing could be tested end to end without real money, and no agent may spend it.

Decisions made by the designer (owner asked for improvements): firm quotes before choosing; the payment-request guard; the purchase journal and startup recovery; the one-time approval code; the test seller with fault switches; per-rental SSH key and port-22 check; markup shown; overspend test rebuilt for purchasing; no model key needed; Arweave testnet default.

## Constraints

- Next.js 16.4.6 with breaking changes: read `node_modules/next/dist/docs/` before using Next APIs (repo `AGENTS.md`). React 19, Tailwind v4 tokens in `app/globals.css`, Vitest, TypeScript strict.
- The session singleton lives on `globalThis`; changes under `lib/` need `POST /api/demo/reset` or a server restart to take effect in the running dev server.
- The app binds to 127.0.0.1. `.env.local` is never printed or committed. Uncommitted setup fixes in the tree (`lib/ans/cose.ts`, `lib/ans/ans.test.ts`, `scripts/register-agents.ts`, `lib/demo/models.ts`, `config/*`, `package*.json`) are left alone: stage files by explicit path only.
- No new runtime dependencies unless unavoidable; `@x402/*` 2.26 and `@solana/kit` are already installed. Do not upgrade `@x402/*` (2.31 breaks types here).
- Privacy: requests to sellers carry no owner name, email or project name. Machine labels are generic (`agent-rental`).
- Existing tests keep passing (302 passed, 7 skipped at branch start). `npx tsc --noEmit` and `npx eslint app lib` stay clean.

## Verification (the finish line)

1. `npm test`, `npx tsc --noEmit`, `npx eslint app lib` clean.
2. **Test market, in the browser:** a run scans, chooses, quotes, stops for approval, pays (a real devnet USDC transfer with a transaction link), shows a machine, destroys it; the meter and records update. Each fallback case and each guard refusal is reproduced with the fault switches.
3. **Real market, free checks:** the scan shows live plans; firm quotes come back from the real seller; a signed `GET /compute/instances` is accepted (confirms the auth template).
4. **Real market, paid (owner only):** the owner funds the throwaway wallet with about $1 USDC, presses Pay and rent once, a machine with a public IP appears and answers on port 22, and it is destroyed. Agents prepare everything up to the approval stop.

## Left to the builder

- File and component names; how the run state is polled (reuse `/api/demo/state` snapshot or a new `/api/market/state`).
- How the old training code is unhooked from the session with the least churn.
- Exact x402 client calls for "build a payment for these requirements" (read `node_modules/@x402/core` and `@x402/fetch` types).
- Polling intervals and timeouts (provisioning usually takes 2–3 minutes on the real seller).

## Answers to the builder check (designer's calls)

- **Devnet money exists.** The devnet buyer wallet (`AGENT_SOLANA_*`) and receiver wallet (`SOLANA_RECEIVER_*`) are already in `.env.local`, each holding 20 devnet USDC (checked 2026-11-24). No faucet step is needed. Only the mainnet wallet is the owner's to fund; the real market falls back to the same keypair when `MAINNET_SOLANA_SECRET_KEY` is unset.
- **The mandate stays local.** It sets the guard's limits and is named in the purchase record. It is never sent to a seller, and the test seller does not check it.
- **Bypass `wrapFetchWithPayment`.** Use `x402Client` / `x402HTTPClient` directly so the guard runs between reading the 402 and signing. `lib/x402/client.ts` is left as is.
- **Old routes stay live but unused** (`/api/provision`, `/api/plans`, `/api/demo/job` and friends). `app/components/AttemptLedger.tsx` exists and is reused by the new overspend test.
- **A restart drops an unapproved quote.** Approval codes live in memory only. Paid machines are recovered through the journal.
- **RunPod and DigitalOcean.** `os_id` per provider as in the plan. A failed port-22 check is reported ("closed") and never fails a run.
- **Destroy now is allowed at any time**, including seconds after renting. The seller's 1-hour minimum is a charge, not a lock.
- **Cancel at the approval stop** ends the run `refused` with code `CANCELLED`; nothing was signed, so nothing is owed.

## Addendum 2026-11-25: market prices (the aggregator view)

Owner asked to close the gap between "one seller's price list" and "the best rate anywhere". Decision: add read-only live prices from providers that publish them without an account, shown beside the seller the agent can buy from. No payment code changes.

Sources (verified live 2026-11-25, all plain GET/POST with no key; fixed URLs; nothing about the owner is sent):
- Vultr direct: `GET https://api.vultr.com/v2/plans?per_page=500` → `plans[]` with `id, vcpu_count, ram` (MB), `hourly_cost, hourly_cost_preemptible, gpu_type, gpu_vram_gb, locations[]`.
- Vast.ai marketplace: `GET https://console.vast.ai/api/v0/bundles/?q=<json>` with `{"rentable":{"eq":true},"verified":{"eq":true},"num_gpus":{"eq":1},"order":[["dph_total","asc"]],"limit":40}` → `offers[]` with `gpu_name, gpu_ram` (MB), `cpu_cores_effective, cpu_ram` (MB), `dph_total` ($/h on demand), `min_bid` ($/h interruptible), `geolocation, reliability2`.
- RunPod direct: `POST https://api.runpod.io/graphql` body `{"query":"{ gpuTypes { id displayName memoryInGb communityPrice securePrice communitySpotPrice secureSpotPrice } }"}` → `data.gpuTypes[]` (prices in $/h; 0 or null = not offered).
- Akash: `GET https://console-api.akash.network/v1/gpu-prices` → `models[]` with `vendor, model, ram` ("40Gi"), `availability{total,available}`, `price{currency,min,max,avg,...}` ($/h).

Rules:
- Each source is fetched with a 6 s timeout and a 2 MB cap, parsed defensively (bad rows skipped, never throws); a failed source is reported and never fails a run.
- A price is a fit when it meets the need (kind; vCPUs, RAM, GPU memory at least what was asked; a dimension the source does not state is not compared, except GPU memory for GPU needs).
- The view shows, per source, the cheapest fit (on-demand price and, when published, the interruptible price), then two plain facts: the cheapest fit anywhere, and the cheapest the agent can actually buy with how much more that is per hour. Sources the agent cannot buy from say so ("no x402 payment yet").
- Prices from other providers are never called quotes and never enter the payment path; only the buyable seller's firm quote can be approved.
- Available two ways: inside a run (fetched during the scan), and on demand through a "Compare prices" action that starts no run.

## Addendum 2026-11-26: public demo mode

**Why.** The owner wants a working public site. Strangers renting with their own money needs wallet signing in the browser and cannot be verified without real funds, so the public site is a demo on the test market; real rentals stay on the owner's computer.

**Two visitors** (`lib/market/access.ts`):
- *Owner*: Host is `127.0.0.1:3000` or `localhost:3000` and the request was not forwarded (no Cloudflare headers, forwarded address is loopback). Everything is allowed.
- *Public*: Host is listed in `BURN402_PUBLIC_HOSTS`. Test market only.
- Anything else is refused (403).

**Public visitors get:** a private session named by an HttpOnly, Secure, SameSite=Lax cookie that `proxy.ts` sets (own run, log, open purchases; the approval code only reaches the session that owns the run), the whole test-market flow, the overspend test, the records page and the price comparison.

**Public visitors never get:** the real market, the model key or the model call, the test seller's HTTP API, another visitor's run, or a server path (the SSH line is `ssh root@<ip>`).

**Limits.** Starts per hour: 10 a session, 20 an address, 150 overall; overspend tests 3, 5 and 20. At most 300 public sessions, 8 an address, dropped after 45 idle minutes (approval cancelled, test machine destroyed; never while a payment is in flight). Request bodies up to 16 KB. `/api/records` answers are cached for a minute.

**Shared test seller.** All sessions use one wallet and one in-process test seller. The overspend test sets its fault switches, so it runs alone: refused while any session's run is talking to the seller, and no run or approval starts while it runs. Payments from the wallet are signed one at a time, 1.5 s apart, so two identical transfers never share a blockhash.

**Known limits.** (1) After an unclear payment outcome a run adopts a new machine of the same plan and region from the wallet's list; with a shared wallet that could be another visitor's. On the test market this path only occurs under the overspend test's faults, which run alone. (2) The devnet wallet is finite (about $0.0104 a rental); when it runs dry, rentals fail before paying until it is refilled. (3) A quick tunnel's address changes when it restarts, and the site is only up while the owner's computer is.

**Going live.** `npm run public` builds, opens a Cloudflare quick tunnel, and starts the production server with `BURN402_PUBLIC_HOSTS` set to the tunnel's host and `BURN402_TEST_SELLER=1`.

## Addendum 2026-11-26: paying from a connected wallet

**Why.** The owner wants visitors to rent with their own money on mainnet. This addendum is the first step: the owner's page can pay from a wallet in the browser. The public site still pays from its shared devnet wallet only.

**The constraint that shapes it.** The seller ties a machine to the wallet that paid and asks that wallet for a fresh signature (address, method, path, time, nonce) on every status check, list and destroy. A browser wallet as the x402 payer would need a popup for each status check while the machine boots.

**Approaches.**
1. *The wallet is the x402 payer.* One popup to pay and no SOL needed, but the machine then belongs to the visitor's wallet and every management call needs another popup. Rejected.
2. *Deposit to the agent's wallet, which pays.* Works with any facilitator, but the server holds visitors' money, needs refunds when a purchase fails, and mixes it with the owner's funds. Kept as the fallback if (3) is refused on mainnet.
3. *Token approval (chosen).* The visitor's wallet signs one SPL `ApproveChecked` for exactly the quoted amount to the agent's wallet. The agent signs the x402 `TransferChecked` out of the visitor's account as its delegate. No custody, an on-chain cap equal to the quote, and the agent owns and manages the machine. The x402 reference facilitator names the transfer authority as the payer and does not require the source account to be the authority's own, and it tolerates Phantom's Lighthouse instructions; whether the real seller's facilitator does the same is not known.

**Flow** (`lib/market/delegate.ts`, `DemoSession.walletApproval` and `approveMarket`, `POST /api/market/wallet`, `POST /api/market/approve`):
1. `POST /api/market/run` takes `wallet` (a 32-byte base58 address). The run's payer signs as the agent and carries `funds`, the visitor's address. Such a run always stops for approval.
2. At the approval stop the page asks `POST /api/market/wallet` for the approval transaction: legacy format, fee payer the visitor, `ApproveChecked(source = the visitor's USDC account, delegate = the agent, amount = the quote)` and a memo `burn402 <digest of run id and one-time code>`. It is refused in plain words when the wallet holds no USDC, too little, or no SOL for the fee.
3. The wallet signs (Wallet Standard `solana:signTransaction`, hand-rolled discovery in `app/components/wallet.ts`; no key ever reaches the page or the server). The signed bytes go to `POST /api/market/approve` with the code.
4. The server checks the signed transaction: signed by the visitor's wallet, which pays its fee; exactly one token instruction, the approval above; this run's memo. A wallet's own extra instructions from other programs are allowed. Then it sends it and the run goes on to pay.
5. Before the agent signs the payment it waits (up to 60 s) until the chain shows delegate = the agent and at least the amount; the chain, not the browser, is what lets it pay.
6. The payment is the exact scheme's transaction (compute limit, compute price, `TransferChecked`, memo) with the visitor's account as the source and the agent as authority. The record names the visitor's wallet as the payer; the chain lookup finds the transfer by the agent's signature and the visitor's balance change.

**Why the memo.** A wallet may be left with an unused approval to the agent (a payment refused after the approval landed). Without the memo, another session could name that wallet and spend it. The server only proceeds on a transaction that wallet signed carrying this run's digest, which nobody else can produce.

**Non-goals for now.** Public visitors paying from their own wallet (refused in `POST /api/market/run`); sponsoring the approval's network fee; revoking a leftover approval from the page (the next approval overwrites it, and the wallet can revoke it).

**Proven 2026-11-27 on devnet** (`scripts/wallet-test.ts`, against the running app): a stand-in wallet signed the approval as a browser wallet would; the delegated payment settled through the hosted facilitator (transaction `xo9fezymvgNYB1mVUQkNc3ez3NEUWxBes7SomQiJ52SQcmnxRicGAiQAZ6GJM8HeWEYpGtw6xUZzF3jyAQzPHAY`), signed by the facilitator's fee payer and the agent only; the stand-in wallet's USDC fell by exactly the quote, the approval was left at zero, and the machine came up owned by the agent and was destroyed.

**Proven 2026-11-27 on mainnet, with Phantom, by the owner.** Phantom signed the approval unchanged enough for the server's checks; the real seller's facilitator accepted the delegated payment (transaction `2M8ScMfZcfGdZA8sULU7A6qXFZ7BvWrfCfWKGTZMpbKCD7ezi2PoBzJf1NTvnuZpetGGaPh5ZFKygLp1H7rhaiLs`) and tied the machine to the agent's wallet, which polled it to active and found SSH open. Seen on that run: (1) the seller's order endpoint timed out (60 s) on the first plan before anything was signed; the run fell back to another plan at the same price and stopped for a second approval, which replaced the first; (2) the page drops its wallet connection whenever Phantom locks or switches account, and needs Connect pressed again. Open before this goes public: reconnect without a click, an independent security review, and a permanent address.

## Addendum 2026-11-27: security review and hardening

An independent reviewer read the connected-wallet code, the access rules, every route and the repository's history. Result: no back door, no secret in tracked files or in history, and no path that moves a wallet's USDC without that wallet's signature for that run. No Critical or High finding. What it found, and what was done:

| # | Finding | Status |
| --- | --- | --- |
| F1 | Owner status rested on the Host plus the first `X-Forwarded-For` hop: a proxy that rewrites the Host, or a visitor sending `X-Forwarded-For: 127.0.0.1`, could look like the owner behind a front end other than the Cloudflare launcher. | Tightened: any non-local hop, or a `Forwarded`, `Via` or `X-Real-IP` header, means forwarded. A proxy that rewrites the Host and adds nothing still cannot be told from the owner; the README forbids it. **Open before real money is offered publicly:** a separate public process without the mainnet key, or an owner secret. |
| F2 | The approval checker relayed a signed transaction with any extra instructions or signers beside the approval. | Fixed: one signer; only the token program (once), memo, compute budget and Lighthouse; at most 8 instructions. |
| F3 | One key signs for public devnet visitors and for the real market. | Done on the owner's machine: `MAINNET_SOLANA_SECRET_KEY` is now a separate wallet, so the key the public demo signs with on devnet is not the real market's. |
| F4 | An approval can be left on chain (a send that timed out but landed, a cancel mid-send, a refused payment); the page cannot revoke it. | Fixed: wording is honest about a send that may still land, and a wallet-funded run that ends unpaid after an approval was sent offers **Check and revoke** (an SPL Revoke the wallet signs, checked like the approval, proven on devnet with `npm run wallet:test -- 0 revoke`). |
| F5 | Error bodies to public visitors were not filtered for server paths. | Fixed in every route. |
| F6 | The reset and records routes relied on the proxy alone for the cross-site check. | Fixed: each applies the rule itself. |
| F7 | Any well-formed session id was accepted. | Fixed: the cookie carries the server's HMAC on the id. |
| F8 | The tunnel could serve another program started on the port within three minutes of the app stopping. | Fixed: the watchdog closes the tunnel at once when the port's listener is not the app. |
| F9 | A scratch path with the macOS user name in a plan document; `.impeccable/` not ignored. | Fixed going forward (the path remains in earlier history). |

Also added: a content security policy (`default-src 'self'`, same-origin connections only), `Cross-Origin-Resource-Policy`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`; owner writes the browser marks `Sec-Fetch-Site: cross-site` or `same-site` are refused; the page reconnects to the wallet without a click after the wallet locks or switches account.

**Still required before connected wallets open to public visitors:** F1's robust fix, limits per wallet and per address on the two routes that call the Solana node, a way for a visitor to reach the machine they paid for (their own SSH key), and a rule for a visitor's money when the seller keeps a payment.

## Addendum 2026-11-27: which quote the agent takes

The lowest firm quote wins, compared on the exact amount. The real seller quotes in whole cents for small machines, so the three cheapest 1 vCPU plans all came back at exactly $0.0100, and the agent kept the first in the chooser's order: the plan with the lowest provider list price, which is the weakest of the three. Now a tie goes to the better machine (`betterMachine` in `lib/market/choose.ts`): more vCPUs, then more memory, then more GPU memory, then on-demand over interruptible, then the higher provider list price, then the plan name. The chooser ranks equal estimates the same way, a fallback after a failed purchase uses the same order, and the run's view carries a `choice` sentence the page shows when the lowest quote was shared.

Not changed: the agent still asks for at most three firm quotes (each takes the real seller 3 to 18 seconds). A fourth plan that would also have quoted the same cent is not asked.

## Addendum 2026-11-27: the plan list, the owner key, and public wallet payments

**Plan list.** While there is no run, the right column lists the plans that fit the form's filters and limits, in the order the agent would ask them, and refreshes as the filters change (350 ms after the last change). `POST /api/market/plans` answers from the seller's price list, read at most once a minute per market and shared by every visitor (`cachedCatalog`). Estimates only: the order endpoint is never called and nothing is paid.

**Owner key (closes F1).** `BURN402_OWNER_TOKEN`, 64 hex characters made by the launcher on every start. When it is set, a local, not-forwarded request is the owner only if it carries the key: the `b402_owner` cookie (HttpOnly, SameSite=Strict) or the `x-b402-owner` header. `GET /api/owner?token=…` hands the key to the browser: it answers on this computer only, stores the cookie and redirects to `/`. The app's own calls to its test seller carry the header (`SellerClient`'s default fetch, for the local test seller only; never to another host). `scripts/wallet-test.ts` and `scripts/market-sweep.ts` read `.burn402/owner-token`. Without the variable (plain `npm run dev`) the local name alone is the owner.

**Public wallet payments.**
- *Test market:* a public visitor may pay from their own wallet on devnet (their own devnet USDC and SOL).
- *Real market:* only when the owner starts with `npm run public -- --real` (`BURN402_PUBLIC_REAL=1`). Then a public run on the real market must be wallet-funded and must bring the visitor's SSH public key; the budget cap stays $1. A visitor never spends the agent's wallet.
- *SSH key:* one OpenSSH public key line (`ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp*`), checked by `sshPublicKeyOf` on the server and the same pattern in the form. With it the run makes no key on this computer and the login line is `ssh root@<ip>`.
- *Shared agent wallet:* every public machine belongs to the one agent wallet, so a public run never adopts a machine by plan and region after an unclear payment (`adopt: false`); it ends as an open purchase the visitor can see.
- *Limits:* preparing, sending or revoking an approval is counted per session, per address and overall (`wallet` in `lib/demo/limits.ts`), since each asks the Solana node.
- *Refunds:* none by this site. The money goes from the visitor's wallet to the seller; the approval stop says so before the visitor approves, and an unclear payment stays listed with its transaction.

**Why `--real` is off by default.** The machines are rented under this app's agent identity at the seller, and a visitor has root on theirs. Opening that to strangers is the owner's decision each time the site is started. It also still runs from the owner's computer behind a quick tunnel, so a visitor's page goes away if the computer sleeps (the machine itself runs to the end of its paid time, and the visitor has its address and their own key).

## Addendum 2026-11-27: second security review (the owner key and public wallet payments)

An independent reviewer read everything after commit 02a986d. No Critical or High finding; with the real market closed to the public (the default) it judged the change safe to ship. What it found, and what was done:

| # | Finding | Status |
| --- | --- | --- |
| A | With one agent wallet shared by the owner and visitors, the owner's run could adopt a visitor's machine after an unclear payment (an automated check raised this first). | Fixed: visitors' real rentals are signed by their own agent key; while the site is public nobody adopts or destroys by plan and region; the journal records which agent wallet paid and recovery uses that wallet. |
| M1 | `--real` fell back to the owner's mainnet key when no key for visitors was set. | Fixed, fail closed: no fallback (`secretFor`), `publicReal()` is false without a distinct `PUBLIC_MAINNET_SOLANA_SECRET_KEY`, and the launcher refuses `--real` without it. |
| L1 | "Wallet-funded and own SSH key" for a public real run was checked only in the route. | Fixed: `newMarketRun` refuses it too. |
| L2 | The owner key failed open when set but too short, and on a hand-set public host with no key. | Fixed: a public site with no valid key has no owner at all. |
| L3 | The owner link put the key in a URL (process list, scrollback, browser history) and was opened even if the app had not started. | Fixed: the link carries a one-time code that is exchanged for the key once; it is opened only after this app answers. Left as is: the cookie is sent to other servers on 127.0.0.1 (cookies ignore ports); they are the owner's own, and they cannot use it from another machine. |
| L4 | The price comparison read the real seller's price list on every request. | Fixed: it uses the one-minute cache. |
| L5 | The SSH key's free-text comment went to the seller verbatim. | Fixed: only the key type and the key are sent. |
| L6 | `market:sweep` could not see machines on the visitors' agent wallet. | Fixed: `--audience public` lists them (never destroys them). |

**What no code change removes.** With `--real`, strangers get root on real machines rented under an agent identity this app controls. The separate key keeps that away from the owner's own wallet and machines, but abuse still lands on that identity at the seller. It stays the owner's decision each time the site is started.
