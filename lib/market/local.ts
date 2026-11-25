/**
 * The local-only rule, as a pure function of a few header values. Shared by the request proxy
 * (proxy.ts, which must not import node:fs or anything that does) and the market routes.
 */

/** The port the app listens on (`npm run dev`); `PORT`, when set, is allowed too. */
export const APP_PORT = 3000;

type Env = Record<string, string | undefined>;
export type LocalHeaders = { host: string | null; origin: string | null };

function ports(env: Env): number[] {
  const extra = /^\d{1,5}$/.test(env.PORT ?? "") ? Number(env.PORT) : null;
  return extra !== null && extra !== APP_PORT ? [APP_PORT, extra] : [APP_PORT];
}

export function localHosts(env: Env = process.env): Set<string> {
  return new Set(ports(env).flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]));
}

export function localOrigins(env: Env = process.env): Set<string> {
  return new Set([...localHosts(env)].map((h) => `http://${h}`));
}

/**
 * Null when the request was addressed to this app by its local name (a DNS-rebinding page arrives
 * with its own host name) and, with `origin`, any Origin header is this app's own; else the reason.
 */
export function localVerdict(h: LocalHeaders, opts: { origin: boolean }, env: Env = process.env): string | null {
  const hosts = localHosts(env);
  if (!hosts.has(h.host ?? "")) return `this app only answers on ${[...hosts].join(" or ")}`;
  if (opts.origin && h.origin !== null && !localOrigins(env).has(h.origin)) return "requests from other websites are not allowed";
  return null;
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The proxy's rule for a request under /api: writes get host and origin checks; every GET and HEAD gets the host check (a DNS-rebinding page must not read state, records or prices). */
export function proxyVerdict(method: string, _pathname: string, h: LocalHeaders, env: Env = process.env): string | null {
  const m = method.toUpperCase();
  if (!READS.has(m)) return localVerdict(h, { origin: true }, env);
  if (m !== "OPTIONS") return localVerdict(h, { origin: false }, env);
  return null;
}
