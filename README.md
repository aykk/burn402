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
cp env.example .env.local          # your agent's Solana wallet, the test seller's address, an optional model key
npm run register-agents            # mints your agent's and the record signer's ANS identities
npm run dev                        # http://127.0.0.1:3000
```

`npm run demo` does the ANS, registration and dev-server steps in one go.

`npm test` runs the unit suite. `npm run test:live` checks ANS, Arweave and the real seller with free calls only (no payment). `npm run market:sweep -- --market test|real` lists, and on the test market destroys, every machine your wallet owns.

By default the app only answers on `127.0.0.1:3000` and `localhost:3000`.

## A public demo

```bash
brew install cloudflared
npm run public                     # builds, opens a Cloudflare quick tunnel, prints the public https address
```

Anyone with the address gets the whole flow on the **test market only** (test money, simulated machines), each in a private session with its own run, log and purchases. Starts are rate limited per visitor, per address and overall, because every visitor spends the same devnet wallet.

The real market, the model key and the test seller's own API stay owner-only: they answer on `http://127.0.0.1:3000` from this computer and are refused on the public address. The site is up while the command runs, and a quick tunnel gets a new address each time. To use a host name of your own instead, put it in `BURN402_PUBLIC_HOSTS` (comma separated) and set `BURN402_TEST_SELLER=1` for a production build.

## Layout

| Path | What lives there |
| --- | --- |
| `lib/market` | The renting agent: catalog, chooser, spending guard, payer, seller client, journal, test seller, chain lookup |
| `lib/market/prices` | Read-only live prices from Vultr, Vast.ai, RunPod and Akash |
| `lib/mandate` | Mandate signing, verification and the attenuation rules |
| `lib/ans` | ANS resolution backed by transparency log proofs |
| `lib/anchor` | Arweave records |
| `lib/verify`, `lib/auditor` | Independent re-verification of records, used by `/records` and the CLI |
| `lib/x402` | The x402 payment processor the test seller settles with |
| `lib/demo` | The app's session, runtime, log and model picker |
| `app/` | The Rent, Records and Overspend test pages and their API routes |
