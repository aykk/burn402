import { VultrResource } from "../burn";
import { settleOnReset } from "../market/recover";
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

export async function resetSession(): Promise<DemoSession> {
  const previous = holder.session;
  holder.session = null;
  if (previous) {
    try {
      // test machine destroyed, approval cancelled, real machine kept (see settleOnReset)
      await settleOnReset((await previous).market);
    } catch {}
    try {
      const old = (await previous).rt;
      old.broker.stopReaper();
      old.wallets.stop();
      old.servers.stop();
      if (old.resource.kind === "vultr") await (old.resource as VultrResource).sweep();
    } catch {}
  }
  return getSession();
}

