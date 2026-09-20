# burn402

Give an agent a budget instead of your API key. It rents a real server, trains your model, hands it back, and the box shuts itself off when the money runs out.

## What it does

An agent with an ANS identity is given limits and demands for a custom model from the user. It talks to a Vultr agent (also with an ANS identity), and they negotiate over which CPU plan suits the model. Once both agents sign, the agent pays over x402 to rent the CPU instance, and uses it to train the model the user requested. The entire interaction, pass or fail, is uploaded to Arweave to ensure the record is untouchable, public, and permanent.

**A clean agent sits at a trust score of 100, and every anchored violation halves it:** one failure drops it to 50, two to 25. We chose to halve rather than drop incrementally because a single fail means it sucks at its job, and fails can lead to massive consequences when handling company (larger-scale) demands. The score is computed from the verdicts anchored on Arweave and attributed to the agent's ANS identity, so it can't be tampered with.

In depth: your agent gets registered an ANS identity of its own, so that all records and transactions (and failures) can be attributed to it. You then give the agent training data, as well as what you require from a custom model, and set three limits: a **total budget**, an **hourly spend rate**, and a **timeframe**.

Your agent then opens an A2A conversation with a second agent that sells Vultr compute (named `Vultr desk`). Both sides sign every message and verify the other against keys tied to its ANS identity, sealed in a transparency log. The desk quotes real plans at real prices for CPU instances with timings for that exact job, and recommends plans. For example, in one of our runs our agent pushed for a cheaper four core box and the desk refused, pointing out that the job splits into sixteen parallel pieces and four cores would run them in four serial batches, AKA it would make the work take four times longer, which went against the original wishes of the user.

Once they agree, the agent pays the broker per request over x402 in USDC on Solana (Devnet for demo), and the broker provisions the instance. **Only the broker holds the Vultr key**, so no agent in the chain ever touches it. The box boots, trains, serves its own progress, and hands back a model as plain JSON that runs in your browser. Then the box is released, destroys itself, and the model keeps working without it.

## Web3 stuff

You don't request burn402 for a CPU instance, your agent actually buys one, which is made possible with x402. The broker answers the agent's request with `HTTP 402` and a price, the agent pays that price in USDC on Solana devnet through an x402 facilitator, and **the machine only boots once the payment settles**. Using Solana and Arweave is what allows us to create a receipt for the auditor to check later (along with Solscan).

The payments are **SPL token transfers**, and there is one per request instead of a single settlement at the end. A job costs between `0.0006` and `0.0165` USDC depending on which plan the two agents agree on, so a session is a handful of tiny machine-to-machine payments. Every one of them returns a transaction signature you can open on Solscan, and the broker signs a receipt containing that signature, the mandate it was paid against, and who paid. That receipt is what we anchor on Arweave, so the payment and the reason for it stay attached to each other.

The dashboard reads both wallets from the chain with `getTokenAccountsByOwner`, so you can watch the agent's USDC balance drop and the broker's climb while the job runs. Here is a real one from our GoDaddy documentation run: `0.011 USDC` for a `vhp-8c-16gb-amd` instance, on devnet.

```
5MwMc15SMDKLZS88ACd83Fv4ACfdvZ1KNEYAR29B6pQMZd2QEtwMWbqaFYqbX7v1VDLdMSTS46bY2HA5vj485eXK
```

## How we built it

`Next.js` for web platform, `Arweave` for storage, `x402` for payment gateway, `Ed25519` and `JWS` for signatures.

**The mandate is the core:** a signed permission slip with a budget, an hourly ceiling, a scope and an expiry, plus eight attenuation rules that the broker checks before anything is provisioned. The x402 gate answers `402`, verifies the payment, provisions, settles and signs a receipt. A reaper watches the burn rate and destroys the instance once reaching zero.

The trainer on the box uses only the Python standard library: a hashed tf-idf classifier trained by gradient descent, a character n-gram language model, and a tf-idf passage index. All three start from scratch on your data. **Nothing is pretrained** (check it yourself!)

The auditor takes public evidence, runs the same eight checks, and signs a verdict that carries the evidence it was made from, so anyone can reproduce it. Verdicts feed the Trust Index as a behaviour score, and anchored records live on Arweave attributed to the agent's domain (ANS identity).

**Timings are measured.** We rented one box per Vultr CPU family and timed the same job on each, then fitted a cost model to the shape of the data. The page shows predicted time against actual, so you can see whether the estimate was realized.

## Check it yourself

Every transaction, approval, every refusal and every broken rule is signed and written to Arweave (Testnet or Mainnet). Anyone can re-run the audit from the public record with one command:

```bash
npm run burn402 -- verify <arweave-txid>
```

It downloads the record, checks the auditor's signature against the key sealed in the transparency log, checks the evidence hash, and runs every check again. `/records` does the same in the browser for every record burn402 has written. `/audit` lets you pick an agent that has run a job and set a second agent loose on its budget.

## Supports:

- Vultr instances at Vultr's own hourly prices, provisioned and destroyed through their API.
- USDC on Solana devnet, settled through an x402 facilitator.
- ANS identities registered against the reference registration authority and transparency log.
- Arweave mainnet records, uploaded with the auditor's and broker's own keys.
- Timings from measurement: single-core runs on each Vultr CPU family, fitted to the shape of your data.

## Running it

burn402 talks to three services you run alongside it. The ANS registration authority and transparency log come from [agentnameservice/ans](https://github.com/agentnameservice/ans), cloned next to this README as `ans/`. The Trust Index reads anchored breach records and turns them into a behaviour score.

```bash
git clone https://github.com/agentnameservice/ans.git
ans/scripts/demo/start.sh          # registration authority on :18080, transparency log on :18081
npm install
cp env.example .env.local          # Vultr key, Solana keypairs, a model API key
npm run register-agents            # mints the broker, auditor and stress tester identities
npm run trust-index                # behaviour scores, on :8090
npm run dev
```

`npm test` runs the unit suite. `npm run test:live` runs the same paths against Vultr, Solana, ANS and Arweave for real. `npm run vultr:sweep` destroys anything left behind.

## Layout

| Path | What lives there |
| --- | --- |
| `lib/mandate` | Mandate signing, verification and the attenuation rules |
| `lib/x402` | The payment gate: 402 challenge, verify, settle, receipt |
| `lib/burn` | Broker, burn accounting, reaper, Vultr adapter |
| `lib/ans` | ANS resolution backed by transparency log proofs |
| `lib/anchor` | Arweave records for verdicts and transactions |
| `lib/auditor` | Reproducible verdicts from public evidence |
| `lib/verify` | Independent re-verification, used by the CLI and `/records` |
| `lib/train` | Dataset detection, cost model, boot script, trainers and model runtimes |
| `agents/` | Agent programs: the company agent and the stress tester |
| `app/api/agents/vultr` | The Vultr desk agent, answering signed A2A quote requests |
