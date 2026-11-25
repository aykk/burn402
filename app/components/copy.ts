// Long explanations shown behind the dotted-underline help labels. Sentence case, plain verbs.
export const HELP: Record<string, string> = {
  agent:
    "Carries the budget and timeframe for this instance. Negotiates with the broker and pays it. Name it to get its own registered identity, so that all transactions and records can be attributed to it. Not to be confused with the model you are training.",
  data: "Files or a URL the custom model learns from. Drop them here or paste a link, and the agent reads them before it rents compute.",
  task: "Describe what the custom model should learn to do. The agent uses this to pick a plan and judge the result.",
  budget: "The most the agent may spend on this run in total.",
  rate: "The most the agent may pay per hour of compute. Plans that cost more per hour than this are ruled out.",
  deadline: "How many minutes the run may take. The agent will not rent a plan that cannot finish in time.",
  preference: "Choose whether the agent leans toward the cheapest plan, the fastest plan, or a balance of the two.",
  publish:
    "Your own words go on Arweave with the negotiation, permanently and publicly. Off by default: only the broker's side is stored as text, yours as a hash.",
  empty:
    "When a job finishes, the model produced lands here and can run in your browser. You can also download the model directly.",
};

// What to do after a failed run, by the stage it stopped in. `kept` is what is left of the budget.
export const NEXT_STEP = {
  deal: "Raise the hourly limit or pick a cheaper plan, then start the run again.",
  later: (kept: string) => `Your budget kept ${kept}. Start the run again; nothing more is charged until a new plan is rented.`,
};

// The rent page's help labels. Long explanations live here so they can be reworded in one place.
export const RENT_HELP = {
  describe:
    "Say in plain words what machine you need and for how long. A model fills in the fields below; it never picks the plan or touches payment. Check the fields before you start.",
  market:
    "Test pays real devnet USDC to a test seller that runs simulated machines, so nothing costs real money. Real pays USDC on Solana mainnet to x402layer for a real machine, and always waits for you before paying.",
  kind: "CPU for general work. GPU when you need graphics memory, for example to run or train a model.",
  size: "The smallest machine your agent may rent. Bigger plans are fine if they are the cheapest that fit.",
  hours: "How long you need the machine. The seller may bill a minimum, often one hour. The machine is destroyed when the time is up.",
  regions: "Seller region codes such as ewr or fra, separated by commas. Leave empty for any region.",
  budget: "The most your agent may pay for this rental in total. The payment check refuses anything above it.",
  rate: "The most your agent may pay per hour of machine time. Plans that cost more per hour are left out.",
  spot: "Interruptible machines are cheaper but can be taken back by the provider at any time.",
  ask: "Your agent stops with the exact payment and waits for you to press Pay and rent. The real market always asks.",
} as const;
