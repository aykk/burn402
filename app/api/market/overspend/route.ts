import { publicLimit } from "@/lib/demo/limits";
import { allSessions } from "@/lib/demo/session";
import { visit } from "@/lib/demo/visit";
import { OVERSPEND_LIMITS, runOverspendTest } from "@/lib/market/overspend";
import { takeOverspendLock } from "@/lib/market/overspend-lock";
import { checkRequest, findPaymentFor, marketJournal, payerFor, sellerFor, sshKeyDir } from "@/lib/market/session";
import { getTestSeller } from "@/lib/market/testseller";

/**
 * Runs the overspend test against the test seller (devnet). Attempt 5's dishonest seller keeps one
 * real devnet payment of about one cent. The test sets the shared test seller's faults, so it runs
 * alone: not while the asker has a run going, not while anyone's run is talking to the seller, and no
 * run or payment may start until it is done.
 */
export async function POST(request: Request) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const who = await visit(request, { create: false });
  if (who instanceof Response) return who;
  const release = takeOverspendLock();
  if (!release) return Response.json({ error: "The overspend test is already running. Try again in a moment." }, { status: 409 });
  try {
    if (who.session?.marketBusy) {
      return Response.json({ error: "a purchase is in progress; finish or destroy it before running the overspend test" }, { status: 409 });
    }
    if (allSessions().some((s) => s.marketWorking)) {
      return Response.json({ error: "Another rental is being set up right now. Try again in a few seconds." }, { status: 409 });
    }
    const limited = publicLimit("overspend", who.v);
    if (limited) return Response.json({ error: limited }, { status: 429 });
    const testSeller = getTestSeller();
    if (!testSeller) return Response.json({ error: "the test seller needs SOLANA_RECEIVER_ADDRESS" }, { status: 503 });
    const payer = await payerFor("test");
    if (!payer) return Response.json({ error: "no wallet is set up for the test market" }, { status: 400 });
    const root = who.rt.config.root;
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
    // a public visitor gets no detail: a failure here can name files on the server
    return Response.json({ error: who.v.kind === "owner" ? (error as Error).message : "The overspend test could not run. Try again later." }, { status: 500 });
  } finally {
    release();
  }
}
