# burn402

Set a budget. Your agent rents the compute. It finds the cheapest machine that fits, pays for it with x402 on Solana, and destroys it when the time is up, and it can never spend past the limits you set.

🏆 **Winner: [MLH] Best Use of Solana at VTHacks 14** · [Devpost](https://devpost.com/software/burn402) · [Demo video](https://www.youtube.com/watch?v=YrKT41mxkuI)

The hackathon version negotiated with a Vultr agent and trained a model on the rented box. This version is a purchasing agent: no negotiation and no training, just finding the best rate and renting the machine with hard spending limits.

## What it does

You say what you need (CPU or GPU, vCPUs, memory, hours, regions) and set two limits: a **total budget** and an **hourly limit**.

1. **Scan.** Your agent reads the seller's live price list and keeps the plans that fit your machine and your limits.
2. **Choose.** It asks for firm quotes on the cheapest few, falls back to another plan or region when one is out of stock, and picks the lowest. When several plans quote exactly the same amount, it takes the best machine among them (more vCPUs, then more memory, then the stronger class) and says so.
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

**Pay from** can be switched to **My wallet**: your own wallet in the browser, paying in USDC on Solana (Phantom, Solflare, Backpack, MetaMask's Solana accounts) or on Base (MetaMask and other Ethereum wallets; see below). This part is about Solana. The site never holds its key or its money. The owner can do this on either market. A public visitor can on the test market, and on the real market only when the owner opened it (see *A public demo*); a visitor's real machine is set up with the visitor's own SSH public key, so only they can log in.

1. **Connect.** The wallet shares its address. Nothing is signed.
2. **Approve.** At each payment the wallet is asked to sign one transaction: let the agent move exactly the quoted amount of USDC out of your account (an SPL token approval), with a note tying it to this run. The wallet pays that transaction's network fee, well under a cent of SOL.
3. **Pay.** The server checks what the wallet signed (your signature, this run's note, exactly the quoted amount to this run's agent, no other token instruction), puts it on chain, waits until the chain shows the approval, and only then lets the agent pay the seller over x402 out of your account. The money goes from your account straight to the seller.

The agent's wallet, not yours, signs the payment and so owns the machine. That is on purpose: the seller asks the paying wallet for a fresh signature on every status check and on destroy, which a browser wallet could only answer with a popup each time.

A run paid this way always stops for your approval. The spending limits are checked before your wallet is asked, as on every run. If a run ends without paying after your wallet approved, the page offers to check the chain and revoke the unused approval.

**Proven on mainnet (2026-11-27):** a real rental paid from Phantom. Phantom signed the approval for exactly $0.01 USDC, the agent paid x402layer out of that wallet (transaction `2M8ScMfZcfGdZA8sULU7A6qXFZ7BvWrfCfWKGTZMpbKCD7ezi2PoBzJf1NTvnuZpetGGaPh5ZFKygLp1H7rhaiLs`, signed by the agent and the seller's fee payer only), the approval was used up, and a real Vultr machine came up with SSH open, managed by the agent. The same flow passes on devnet with a stand-in wallet (`npm run wallet:test`).

### From an Ethereum wallet (MetaMask and others), on Base

Under **My wallet**, choose **Base** instead of **Solana** to pay from an Ethereum wallet: MetaMask, Coinbase Wallet, Rabby, Rainbow, Phantom's Ethereum side, or any other browser wallet that announces itself the standard way (EIP-6963). The payment is USDC on Base. It works differently from the Solana path, because the trick used there has no Ethereum equivalent:

1. **Connect.** The wallet shares its address. Nothing is signed.
2. **Sign.** At the payment the wallet is asked to sign one message: move exactly the quoted amount of USDC from this wallet to the seller (an EIP-3009 transfer authorization, which is how x402 pays on Ethereum-type chains). The wallet shows every field. Signing is free: the wallet sends no transaction and pays no network fee, and it needs no ETH.
3. **Pay.** The server checks that the signature is this wallet's signature of exactly the message it prepared, then sends it to the seller with the order. If the seller's terms changed in between (amount, recipient, token, network), the signature no longer fits and nothing is paid.

The wallet pays the seller itself, so **the machine belongs to the wallet**, not to the agent. The seller answers questions about a machine only to its owner, with a fresh signature every time (it refuses a repeated one). So on this path the app cannot watch the machine or destroy it by itself:

- **Check machine** asks the wallet to sign a short sign-in message, then shows the machine's address. On the real seller a machine takes two to three minutes to come up.
- **Destroy now** asks for one more signature.
- When the prepaid time is up the rental ends on the page. The app did not destroy the machine and says so; a prepaid machine is the seller's to switch off.

The sign-in messages move no money and cost nothing. The spending limits, the fixed-price check and the one-payment rule apply as on every run. The site never holds the wallet's key or its money.

RainbowKit is not used. It would add a QR code for phone wallets, but it needs an account with WalletConnect and lets the page talk to their servers; today the page talks to nothing but itself. Browser-extension wallets are found without it.

**Status:** tested end to end on Base's test network with a stand-in wallet up to the payment (`npm run wallet:test:base`). Not yet proven: a settled payment, and a real MetaMask signing on the page.

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

Anyone with the address gets the whole flow on the **test market** (test money, simulated machines), each in a private session with its own run, log and purchases, paying from the demo's shared devnet wallet or from their own wallet on devnet. Starts are rate limited per visitor, per address and overall.

`npm run public -- --real` also lets visitors rent **real machines**, paid from their own wallets on mainnet and never from yours (budget up to $1, their own SSH key required). It is off unless you ask for it, and it needs `PUBLIC_MAINNET_SOLANA_SECRET_KEY` in `.env.local`: a separate agent wallet that signs for visitors, so their machines are never rented under your own wallet (without it `--real` refuses to start). A visitor gets full control of the machine they rent. `npm run market:sweep -- --market real --audience public` lists the machines on that wallet. The site cannot refund a payment the seller keeps, and says so before the visitor approves.

The real market and the test seller's own API stay owner-only: they answer on `http://127.0.0.1:3000` from this computer and are refused on the public address.

The tunnel is started once and reused, so running `npm run public` again (to pick up a change) keeps the same address. A watchdog closes the tunnel three minutes after the app is gone, so the address never reaches anything else that starts on port 3000; the launcher also refuses to start while another program holds that port. `npm run public:stop` takes the app and the tunnel down at once; the next start gets a new address. Cloudflare limits how often a free tunnel can be created, so the launcher waits and retries when it is refused. To use a host name of your own instead, put it in `BURN402_PUBLIC_HOSTS` (comma separated) and set `BURN402_TEST_SELLER=1` for a production build.

### How the public site is kept apart

- **Owner or public.** A request is the owner's only when it is addressed to the local name, shows no sign of having been forwarded (no Cloudflare header, no `Forwarded`, `Via` or `X-Real-IP`, no address in `X-Forwarded-For` that is not this computer), **and carries the owner key**. The launcher makes a new key on every start (`BURN402_OWNER_TOKEN`), keeps it in `.burn402/owner-token`, and opens your browser on a link that stores it as a cookie; the scripts read the file. The link carries a one-time code, not the key, and works once: for another browser, run `npm run public` again (the public address stays the same). So a reverse proxy that makes every visitor look local still does not make them the owner. A public site with no key set has no owner at all, so if you run it another way, set `BURN402_OWNER_TOKEN` (64 hex characters) yourself. With plain `npm run dev` nothing is public and no key is needed.
- **Sessions.** A public visitor's session cookie carries the server's signature, so an id a visitor made up is not a session. The launcher makes a fresh signing key (`BURN402_SESSION_SECRET`) on every start; set one yourself if you run it another way.
- **Other websites.** Writes must come from the app's own page: a foreign Origin, or a request the browser marks as cross-site, is refused, by the proxy and again by each route.
- **What a page may load.** A content security policy lets pages load from and talk to this site only, and nothing may frame it.
- **Errors.** Error text sent to a public visitor never names a folder on this computer.
- **The tunnel.** A watchdog closes it at once if anything but this app is listening on port 3000, and three minutes after the app is gone.

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
