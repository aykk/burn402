// The rent page's help labels. Long explanations live here so they can be reworded in one place.
export const RENT_HELP = {
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
