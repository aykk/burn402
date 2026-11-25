import { getSession } from "@/lib/demo/session";
import { OVERSPEND_LIMITS, runOverspendTest } from "@/lib/market/overspend";
import { takeOverspendLock } from "@/lib/market/overspend-lock";
import { checkRequest, findPaymentFor, marketJournal, payerFor, sellerFor, sshKeyDir } from "@/lib/market/session";
import { getTestSeller } from "@/lib/market/testseller";

/**
 * Runs the overspend test against the test seller (devnet). Attempt 5's dishonest seller keeps one
 * real devnet payment of about one cent. Never touches the current run; no run may start meanwhile.
 */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const release = takeOverspendLock();
  if (!release) return Response.json({ error: "the overspend test is already running" }, { status: 409 });
  try {
    const session = await getSession();
    if (session.marketBusy) {
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
      findPayment: findPaymentFor("test"),
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  } finally {
    release();
  }
}
