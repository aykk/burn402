# burn402

Give an agent a budget instead of your API key. It rents a real server, trains your model, hands it back, and the box shuts itself off when the money runs out.

## The problem

Letting an agent rent compute today means giving it a provider API key. That key has no spend limit, no clock, and no way to claw it back once the agent hands work to another agent. Everyone in the chain effectively holds your whole account.

## What replaces the key

A mandate: a signed permission slip carrying a budget, a maximum hourly rate, a scope and an expiry. It can only shrink as it is passed down — a delegated mandate can never raise a limit its parent set, and the broker rejects one that tries.

- **Payment.** The agent pays the broker per request over x402 on Solana devnet. Only the broker holds the Vultr key.
- **Burn.** The budget depletes against the real hourly price while the server runs. At zero, a reaper destroys the instance. No human in the loop.
- **Identity.** Every agent resolves through ANS, with its keys sealed in a transparency log. A signature that does not match a logged key is refused.
- **Memory.** Payments and breach verdicts are anchored on Arweave, keyed on the agent's domain, so a version bump cannot shake a record loose.

## The demo

1. Bring data — upload a file or paste a URL. Any CSV, TSV, JSONL or plain text. burn402 reads the first part of it and works out the columns, the labels and therefore the job: labelled rows train a classifier, plain text trains a character language model.
2. Set a budget (up to $20, the faucet cap) and say whether you want it cheap or fast.
3. Your agent, running on your own model and key, opens an A2A conversation with the Vultr desk agent. Both sides sign every message and check the other's signature against its ANS keys. The desk quotes real plans at real prices with timings for this exact job; your agent pushes back once, then picks.
4. It pays over x402 and the broker provisions the instance. The Solscan link and the Arweave receipt appear as they land.
5. The box trains and serves its own progress. The page shows predicted time against actual.
6. The model comes back as plain JSON and runs in your browser — type at a classifier and it answers as you type; prompt a language model and it writes. Then the server is released.

Nothing about the model is hardcoded in the page. The trainer reports its own metrics, their labels and how to format them, plus the input and output shape it expects, so a new kind of model shows up correctly without touching the UI.

## Check it yourself

Every record on Arweave is re-verified from public data — signature, uploader, evidence, and a full rerun of the audit:

```bash
npm run burn402 -- verify <arweave-txid>
```

`/records` does the same in the browser for every record burn402 has written, and `/audit` shows the identity, delegation and stress-test machinery underneath.

## What is real

- Vultr instances at Vultr's own hourly prices, provisioned and destroyed through their API.
- USDC on Solana devnet, settled through an x402 facilitator.
- ANS identities registered against the reference registration authority and transparency log.
- Arweave mainnet records, uploaded with the auditor's and broker's own keys.
- Timings from measurement: single-core runs on each CPU family, fitted to the shape of your data.

## Running it

burn402 talks to three services you run alongside it: the ANS registration authority and
transparency log from [agentnameservice/ans](https://github.com/agentnameservice/ans), cloned
next to this README as `ans/` and started with its `scripts/demo/start.sh`, and the Trust Index
(`npm run trust-index`).

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
| `lib/train` | Dataset detection, cost model, boot script, model runtimes |
| `agents/` | Agent programs: the company agent and the stress tester |
| `app/api/agents/vultr` | The Vultr desk agent, answering signed A2A quote requests |
