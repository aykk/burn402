import { resetRefusal, settleOnReset } from "../market/recover";
import { configFromEnv, createRuntime } from "./runtime";
import { DemoSession } from "./script";

type Holder = { session: Promise<DemoSession> | null };

const holder = ((globalThis as unknown as { __burn402?: Holder }).__burn402 ??= { session: null });

export function getSession(): Promise<DemoSession> {
  holder.session ??= createRuntime(configFromEnv()).then((rt) => new DemoSession(rt));
  holder.session.catch(() => {
    holder.session = null;
  });
  return holder.session;
}

/** A reset refused because a payment is in flight; the route answers 409 with the message. */
export class ResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetRefusedError";
  }
}

export async function resetSession(): Promise<DemoSession> {
  const previous = holder.session;
  if (previous) {
    // checked before anything is dropped: a run paying or provisioning must stay visible and counted as busy
    const current = await previous.catch(() => null);
    const refused = resetRefusal(current?.market ?? null);
    if (refused) throw new ResetRefusedError(refused);
    if (holder.session !== previous) return getSession(); // another reset got here first
  }
  holder.session = null;
  if (previous) {
    try {
      // test machine destroyed, approval cancelled, real machine kept (see settleOnReset)
      await settleOnReset((await previous).market);
    } catch {}
  }
  return getSession();
}

