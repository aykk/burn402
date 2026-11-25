import { getSession } from "@/lib/demo/session";
import { MARKET_ENDED } from "@/lib/demo/script";
import { OVERSPEND_LIMITS, runOverspendTest } from "@/lib/market/overspend";
import { checkRequest, marketJournal, payerFor, sellerFor, sshKeyDir } from "@/lib/market/session";
import { getTestSeller } from "@/lib/market/testseller";

type Lock = { running: boolean };
const lock = ((globalThis as unknown as { __burn402Overspend?: Lock }).__burn402Overspend ??= { running: false });

/**
 * Runs the overspend test against the test seller (devnet). Attempt 5 makes one real devnet
 * payment of about one cent and destroys the machine it buys. Never touches the current run.
 */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  if (lock.running) return Response.json({ error: "the overspend test is already running" }, { status: 409 });
  lock.running = true;
  try {
    const session = await getSession();
    if (session.market && !MARKET_ENDED.has(session.market.view().phase)) {
      return Response.json({ error: "a purchase is in progress; finish or destroy it before running the overspend test" }, { status: 409 });
    }
    const testSeller = getTestSeller();
    if (!testSeller) return Response.json({ error: "the test seller needs SOLANA_RECEIVER_ADDRESS" }, { status: 503 });
    const payer = await payerFor("test");
    if (!payer) return Response.json({ error: "no wallet is set up for the test market" }, { status: 400 });
    const root = session.rt.config.root;
    const result = await runOverspendTest({
      seller: sellerFor("test", payer),
      testSeller,
      payer,
      journal: marketJournal(root),
      keyDir: sshKeyDir(root),
      limits: OVERSPEND_LIMITS,
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  } finally {
    lock.running = false;
  }
}
