# burn402

Set a budget. Your agent rents the compute. It finds the cheapest machine that fits, pays for it with x402 on Solana, and destroys it when the time is up, and it can never spend past the limits you set.

🏆 **Winner: [MLH] Best Use of Solana at VTHacks 14** · [Devpost](https://devpost.com/software/burn402) · [Demo video](https://www.youtube.com/watch?v=YrKT41mxkuI)

The hackathon version negotiated with a Vultr agent and trained a model on the rented box. This version is a purchasing agent: no negotiation and no training, just finding the best rate and renting the machine with hard spending limits.

## What it does

You say what you need (CPU or GPU, vCPUs, memory, hours, regions) and set two limits: a **total budget** and an **hourly limit**.

1. **Scan.** Your agent reads the seller's live price list and keeps the plans that fit your machine and your limits.
2. **Choose.** It asks for firm quotes on the cheapest few, falls back to another plan or region when one is out of stock, and picks the lowest.
3. **Pay.** It stops to show you the exact payment (unless you turned that off), then pays over x402 in USDC on Solana.
4. **Machine.** It shows the machine, its IP and the SSH command, and destroys it when the prepaid time runs out or when you press Destroy.

Beside the run, live prices from Vultr, Vast.ai, RunPod and Akash show what the same machine costs elsewhere.

## Limits it cannot cross

Every payment request is checked before anything is signed: against the approved quote, the budget, the hourly limit (per billed hour), the network, the token, and a $5 cap on any single payment. The limits are signed by your key as a mandate and admitted by the mandate registry before a run starts.

It never pays twice: a purchase journal is written before signing, a failed paid request is resent unchanged rather than signed again, and an unclear outcome is settled by looking the transfer up on chain.

`/audit` runs the overspend test: five ways to spend more against a dishonest test seller. All five are blocked.

## Two markets

- **Test (devnet).** A local test seller with the same protocol as the real one. It settles real payments in devnet USDC and runs simulated machines, so nothing costs real money.
- **Real (mainnet).** [compute.x402layer.cc](https://compute.x402layer.cc), which resells Vultr and DigitalOcean machines for USDC on Solana mainnet. The real market always stops for your approval.

## Paying from your own wallet

On the owner's page, **Pay from** can be switched from the agent's wallet to **My wallet**: a Solana wallet in the browser (Phantom, Solflare, Backpack, MetaMask). The site never holds its key or its money.

1. **Connect.** The wallet shares its address. Nothing is signed.
2. **Approve.** At each payment the wallet is asked to sign one transaction: let the agent move exactly the quoted amount of USDC out of your account (an SPL token approval), with a note tying it to this run. The wallet pays that transaction's network fee, well under a cent of SOL.
3. **Pay.** The server checks what the wallet signed (your signature, this run's note, exactly the quoted amount to this run's agent, no other token instruction), puts it on chain, waits until the chain shows the approval, and only then lets the agent pay the seller over x402 out of your account. The money goes from your account straight to the seller.

The agent's wallet, not yours, signs the payment and so owns the machine. That is on purpose: the seller asks the paying wallet for a fresh signature on every status check and on destroy, which a browser wallet could only answer with a popup each time.

A run paid this way always stops for your approval. The spending limits are checked before your wallet is asked, as on every run.

**Proven on mainnet (2026-11-27):** a real rental paid from Phantom. Phantom signed the approval for exactly $0.01 USDC, the agent paid x402layer out of that wallet (transaction `2M8ScMfZcfGdZA8sULU7A6qXFZ7BvWrfCfWKGTZMpbKCD7ezi2PoBzJf1NTvnuZpetGGaPh5ZFKygLp1H7rhaiLs`, signed by the agent and the seller's fee payer only), the approval was used up, and a real Vultr machine came up with SSH open, managed by the agent. The same flow passes on devnet with a stand-in wallet (`npm run wallet:test`).

## Records

Every purchase, refusal and failure is signed by your agent's ANS identity and written to Arweave (testnet by default, mainnet if you choose). `/records` reads them back and checks every signature in the browser, including the older verdict and negotiation records from the hackathon version. Those older records can also be checked from the command line:

```bash
npm run burn402 -- verify <arweave-txid>
```

## Running it

burn402 uses the ANS registration authority and transparency log from [agentnameservice/ans](https://github.com/agentnameservice/ans), cloned next to this README as `ans/`.

```bash
git clone https://github.com/agentnameservice/ans.git
ans/scripts/demo/start.sh          # registration authority on :18080, transparency log on :18081
npm install
cp env.example .env.local          # your agent's Solana wallet and the test seller's address
npm run register-agents            # mints your agent's and the record signer's ANS identities
npm run dev                        # http://127.0.0.1:3000
```

`npm run demo` does the ANS, registration and dev-server steps in one go.

`npm test` runs the unit suite. `npm run wallet:test` pays for a test-market rental from a stand-in wallet on devnet, through the running app (the stand-in wallet in `.burn402/keys/standin-wallet.json` needs 0.005 devnet SOL). `npm run test:live` checks ANS, Arweave and the real seller with free calls only (no payment). `npm run market:sweep -- --market test|real` lists, and on the test market destroys, every machine your wallet owns.

By default the app only answers on `127.0.0.1:3000` and `localhost:3000`.

## A public demo

```bash
brew install cloudflared
npm run public                     # builds, opens a Cloudflare quick tunnel, prints the public https address
```

Anyone with the address gets the whole flow on the **test market only** (test money, simulated machines), each in a private session with its own run, log and purchases. Starts are rate limited per visitor, per address and overall, because every visitor spends the same devnet wallet.

The real market and the test seller's own API stay owner-only: they answer on `http://127.0.0.1:3000` from this computer and are refused on the public address.

The tunnel is started once and reused, so running `npm run public` again (to pick up a change) keeps the same address. A watchdog closes the tunnel three minutes after the app is gone, so the address never reaches anything else that starts on port 3000; the launcher also refuses to start while another program holds that port. `npm run public:stop` takes the app and the tunnel down at once; the next start gets a new address. Cloudflare limits how often a free tunnel can be created, so the launcher waits and retries when it is refused. To use a host name of your own instead, put it in `BURN402_PUBLIC_HOSTS` (comma separated) and set `BURN402_TEST_SELLER=1` for a production build.

## Layout

| Path | What lives there |
| --- | --- |
| `lib/market` | The renting agent: catalog, chooser, spending guard, payer, connected-wallet approvals (`delegate.ts`), seller client, journal, test seller, chain lookup |
| `lib/market/prices` | Read-only live prices from Vultr, Vast.ai, RunPod and Akash |
| `lib/mandate` | Mandate signing, verification and the attenuation rules |
| `lib/ans` | ANS resolution backed by transparency log proofs |
| `lib/anchor` | Arweave records |
| `lib/verify`, `lib/auditor` | Independent re-verification of records, used by `/records` and the CLI |
| `lib/x402` | The x402 payment processor the test seller settles with |
| `lib/demo` | The app's sessions, runtime, log and rate limits |
| `app/` | The Rent, Records and Overspend test pages and their API routes |
