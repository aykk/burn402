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
