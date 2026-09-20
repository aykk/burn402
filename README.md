# burn402

Give an agent a budget instead of your API key. It rents a real server, trains your model, hands it back, and the box shuts itself off when the money runs out.

## The problem

Letting an agent rent compute today means giving it a provider API key. That key has no spend limit, no clock, and no way to claw it back once the agent hands work to another agent. Everyone in the chain effectively holds your whole account.

## What replaces the key

A mandate: a signed permission slip carrying a budget, a maximum hourly rate, a scope and an expiry. It can only shrink as it is passed down. A delegated mandate can never raise a limit its parent set, and the broker rejects one that tries.

The agent pays the broker per request over x402 on Solana devnet, so only the broker ever holds the Vultr key. While the server runs, the budget depletes against the real hourly price, and at zero a reaper destroys the instance with no human in the loop. Every agent resolves through ANS with its keys sealed in a transparency log, so a signature that does not match a logged key is refused. Payments and breach verdicts are anchored on Arweave under the agent's domain, which means a version bump cannot shake a record loose.

## The demo

1. Name your agent. It gets its own ANS identity, registered while you wait, and every message it signs and every record about it carries that name.
2. Add data. Drop in as many files as you like, or paste links. CSV, TSV, JSONL or plain text. burn402 reads the start of each one and works out the columns, the labels and the job: labelled rows train a classifier, plain text trains a character language model, and passages with links train a search index over your documents.
3. Say what you want it to do, and set three limits: total budget, hourly cap, and how long it has.
4. Your agent, running on your own model and key, opens an A2A conversation with the Vultr desk agent. Both sides sign every message and check the other's signature against its ANS keys. The desk quotes real plans at real prices with timings for this exact job, then argues its corner. Your agent can take the recommendation or overrule it.
5. It pays over x402 and the broker provisions the instance. The Solscan link and the Arweave receipt appear as they land.
6. The box trains and serves its own progress. The page shows predicted time against actual.
7. The model comes back as plain JSON and runs in your browser. Type at a classifier and it answers as you type. Prompt a language model and it writes. Ask a document index a question and it finds the passage, then hands it to the model you picked to write an answer with a link to the page it came from.
8. The server is released, and the model keeps working without it.

Nothing about the model is written into the page. The trainer reports its own metrics, their labels and how to format them, plus the input and output shape it expects, so a new kind of model shows up correctly without anyone touching the UI.

## Check it yourself

Every record on Arweave is re-verified from public data: the signature, who uploaded it, the evidence it carries, and a full rerun of the audit.

```bash
npm run burn402 -- verify <arweave-txid>
```

`/records` does the same in the browser for every record burn402 has written. `/audit` lets you pick an agent that has run a job and set a second agent loose on its budget.

## Supports:

- Vultr instances at Vultr's own hourly prices, provisioned and destroyed through their API.
- USDC on Solana devnet, settled through an x402 facilitator.
- ANS identities registered against the reference registration authority and transparency log.
- Arweave mainnet records, uploaded with the auditor's and broker's own keys.
- Timings from measurement: single-core runs on each Vultr CPU family, fitted to the shape of your data.

Training starts from scratch on the rented box, using only the Python standard library. No pretrained weights, nothing downloaded, no pip install that can fail at boot. What comes back is a file you can run anywhere.

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
