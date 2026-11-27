// The rent page's help labels. Long explanations live here so they can be reworded in one place.
export const RENT_HELP = {
  market:
    "Test uses play money and pretend machines, so nothing costs real money. Real money spends real USDC (digital dollars on Solana) on a real machine, and always waits for your OK before paying.",
  kind: "CPU for general work. GPU for graphics-heavy work, such as running an AI model.",
  size: "The smallest machine you would accept. A bigger one is fine when it is the cheapest that fits.",
  hours: "How long you need the machine. Sellers often bill at least one hour. It is destroyed when the time is up.",
  regions: "Where the machine should be, as the seller's region codes (ewr is New Jersey), separated by commas. Leave empty for anywhere.",
  budget: "The most your agent may spend on this rental in total. It refuses to pay anything above this.",
  rate: "The most your agent may pay per hour. Plans that cost more are left out.",
  ask: "Your agent shows you the exact payment and waits for you to approve it. Real money always asks.",
  sshKey: "A public SSH key: one line starting with ssh-ed25519 or ssh-rsa (the contents of a .pub file). The machine is set up with it, so only you can log in. Never paste a private key.",
  payFrom:
    "Agent wallet is the wallet this app runs with. My wallet is your own Solana wallet in this browser: for each payment it asks you to approve the exact amount. The site never holds your key or your money.",
} as const;
