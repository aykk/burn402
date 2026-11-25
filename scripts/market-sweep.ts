import { existsSync } from "node:fs";
import { join } from "node:path";
import { marketJournal, payerFor, sellerFor } from "../lib/market/session";
import type { MarketId } from "../lib/market/types";

/**
 * npm run market:sweep -- --market test|real [--yes-destroy]
 * Lists every machine the market's wallet owns and the journal's open purchases, then destroys
 * them: always on the test market, on the real market only with --yes-destroy. Prints ids,
 * plans, regions and statuses; never keys.
 */

const say = (line: string) => process.stdout.write(`${line}\n`);

function args(argv: string[]): { market: MarketId; destroy: boolean } {
  const at = argv.indexOf("--market");
  const market = at >= 0 ? argv[at + 1] : undefined;
  if (market !== "test" && market !== "real") throw new Error("usage: npm run market:sweep -- --market test|real [--yes-destroy]");
  return { market, destroy: market === "test" || argv.includes("--yes-destroy") };
}

async function main() {
  const file = join(process.cwd(), ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
  const { market, destroy } = args(process.argv.slice(2));
  const payer = await payerFor(market);
  if (!payer) throw new Error(`no wallet key is set for the ${market} market`);
  const seller = sellerFor(market, payer);
  const journal = marketJournal();
  say(`${seller.config.label}, wallet ${payer.address}`);

  const instances = await seller.instances();
  const live = instances.filter((i) => i.status !== "destroyed");
  say(live.length === 0 ? "the wallet owns no machines" : `the wallet owns ${live.length} machine(s):`);
  for (const i of live) say(`  ${i.id}  ${i.plan}  ${i.region}  ${i.status}${i.ip ? `  ${i.ip}` : ""}`);

  const open = journal.open().filter((o) => o.market === market);
  say(open.length === 0 ? "the journal has no open purchases on this market" : `the journal has ${open.length} open purchase(s):`);
  for (const o of open) say(`  run ${o.run}  ${o.plan}  ${o.region}  ${o.state}  machine ${o.instance ?? "unknown"}${o.tx ? `  tx ${o.tx}` : ""}`);

  if (!destroy) {
    if (live.length > 0 || open.length > 0) say("nothing destroyed: on the real market add --yes-destroy to destroy these");
    return;
  }

  let failed = 0;
  const gone = new Set<string>();
  for (const i of live) {
    try {
      await seller.destroy(i.id);
      gone.add(i.id);
      say(`destroyed ${i.id}`);
    } catch (error) {
      failed++;
      say(`could not destroy ${i.id}: ${(error as Error).message}`);
    }
  }
  for (const o of open) {
    if (!o.instance) {
      say(`run ${o.run} has no known machine id; left open`);
      continue;
    }
    try {
      if (!gone.has(o.instance)) await seller.destroy(o.instance);
      const after = await seller.instance(o.instance);
      if (after && after.status !== "destroyed") throw new Error(`still listed as ${after.status}`);
      journal.append({ at: Date.now(), run: o.run, market: o.market, seller: o.seller, event: "released", plan: o.plan, region: o.region, usd: o.usd, tx: o.tx, instance: o.instance, detail: "destroyed by market:sweep" });
      say(`run ${o.run} released (${o.instance})`);
    } catch (error) {
      failed++;
      say(`could not release run ${o.run}: ${(error as Error).message}`);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
