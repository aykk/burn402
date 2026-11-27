import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import type { Signer } from "./auth";
import { OWNER_HEADER, ownerToken } from "./access";
import { authHeaders } from "./auth";
import { parsePlansFeed } from "./catalog";
import type { Candidate } from "./choose";
import { atomicToUsd, type Accepts } from "./guard";
import { sellerReason, usdPlain } from "./money";
import { readPaymentRequired, type PaymentRequired } from "./pay";
import { readTextCapped, TooLargeError } from "./read";
import type { HourlyRules, MarketId, Offer } from "./types";

export type SellerConfig = { id: "x402layer" | "testseller"; label: string; baseUrl: string; market: MarketId };

export const SELLERS: { real: SellerConfig; test: SellerConfig } = {
  real: { id: "x402layer", label: "x402layer", baseUrl: "https://compute.x402layer.cc", market: "real" },
  test: { id: "testseller", label: "Test seller (devnet, simulated machines)", baseUrl: "http://127.0.0.1:3000/api/testseller", market: "test" },
};

export type Instance = { id: string; status: string; ip: string | null; expiresAt: number | null; plan: string; region: string };

export type Quote = {
  seller: string;
  market: MarketId;
  candidate: Candidate;
  region: string;
  hours: number;
  amountUsd: number;
  atomic: string;
  accepts: Accepts;
  body: string;
};

export type QuoteErrorCode = "OUT_OF_STOCK" | "PRICE_CAP" | "NO_402" | "SELLER_ERROR" | "UNREACHABLE";

export class QuoteError extends Error {
  constructor(
    public code: QuoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QuoteError";
  }
}

export type ProvisionOutcome =
  | { kind: "active" | "pending"; instance: Instance; tx: string | null }
  | { kind: "unknown"; detail: string }
  | { kind: "not_charged"; code: "REFUSED_BY_GUARD" | "PAYMENT_REJECTED" | "PRICE_CAP" | "OUT_OF_STOCK" | "SELLER_ERROR"; detail: string };

type PayFn = (required: PaymentRequired, accepts: Accepts) => Promise<Record<string, string> | { refused: string }>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

const LABEL = "agent-rental";
const PAID_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
const NO_WALLET = "a wallet is needed to manage machines";
const READ_TIMEOUT_MS = 30_000;
const PAID_TIMEOUT_MS = 60_000;
const STOCK_RE = /stock|unavailable|capacity/i;

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The seller's short reason and a full stop, never its raw answer. */
const said = (text: string) => {
  const r = sellerReason(text);
  return /[.!?…]$/.test(r) ? r : `${r}.`;
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/[.\s]+$/, "");

function osIdFor(provider: string): number | string | undefined {
  if (provider === "vultr") return 2284;
  if (provider === "digitalocean") return "ubuntu-24-04-x64";
  return undefined;
}

function toInstance(raw: unknown): Instance | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const ip = str(raw.ip_address);
  const expires = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : NaN;
  return {
    id,
    status: str(raw.status) || "unknown",
    ip: ip === "" || ip === "0.0.0.0" ? null : ip,
    expiresAt: Number.isFinite(expires) ? Math.floor(expires / 1000) : null,
    plan: str(raw.plan),
    region: str(raw.region),
  };
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v !== "";

/** First well-formed requirement on a Solana network. */
function solanaRequirement(required: PaymentRequired): PaymentRequirements | null {
  const r = required.accepts.find(
    (a) =>
      isObj(a) &&
      typeof a.network === "string" &&
      a.network.startsWith("solana:") &&
      typeof a.amount === "string" &&
      /^\d+$/.test(a.amount) &&
      nonEmpty(a.asset) &&
      nonEmpty(a.payTo),
  );
  return r ?? null;
}

const toAccepts = (r: PaymentRequirements): Accepts => ({ scheme: r.scheme, network: r.network, asset: r.asset, amount: r.amount, payTo: r.payTo, ...(isObj(r.extra) ? { extra: r.extra } : {}) });

function txFrom(body: Obj, response: Response): string | null {
  if (typeof body.tx_hash === "string" && body.tx_hash) return body.tx_hash;
  const header = response.headers.get("PAYMENT-RESPONSE");
  if (!header) return null;
  try {
    const settled = decodePaymentResponseHeader(header);
    return typeof settled.transaction === "string" && settled.transaction ? settled.transaction : null;
  } catch {
    return null;
  }
}

export class SellerClient {
  private readonly fetch: typeof fetch;
  private readonly signer: Signer | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeouts: { read: number; paid: number };

  constructor(
    readonly config: SellerConfig,
    deps: { fetch?: typeof fetch; signer?: Signer | null; now?: () => number; sleep?: (ms: number) => Promise<void>; timeouts?: { read: number; paid: number } } = {},
  ) {
    // The test seller is this app's own API, open to the owner only: the app's calls to it carry the owner key.
    // The key is never sent to another host.
    const own = config.id === "testseller" && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(`${config.baseUrl}/`);
    this.fetch =
      deps.fetch ??
      ((input, init) => {
        const key = own ? ownerToken() : null;
        if (key === null) return fetch(input, init);
        const headers = new Headers(init?.headers);
        headers.set(OWNER_HEADER, key);
        return fetch(input, { ...init, headers });
      });
    this.signer = deps.signer ?? null;
    this.now = deps.now ?? Date.now;
    this.timeouts = deps.timeouts ?? { read: READ_TIMEOUT_MS, paid: PAID_TIMEOUT_MS };
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private url(path: string): string {
    return `${this.config.baseUrl}${path}`;
  }

  async catalog(): Promise<{ offers: Offer[]; rules: HourlyRules; skipped: number }> {
    const response = await this.fetch(this.url("/compute/plans"), { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(this.timeouts.read) });
    const text = await readTextCapped(response);
    if (!response.ok) throw new Error(`${this.config.label}'s price list could not be read (error ${response.status}): ${said(text)}`);
    return parsePlansFeed(parseJson(text), this.config.id);
  }

  /** Paid or not, the seller's order endpoint gets the longer limit: its free quote alone has taken close to 30 s. */
  private postProvision(body: string, headers: Record<string, string> = {}): Promise<Response> {
    const signal = AbortSignal.timeout(this.timeouts.paid);
    return this.fetch(this.url("/compute/provision"), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body, signal });
  }

  async quote(candidate: Candidate, region: string, opts: { sshPublicKey: string; maxTotalUsd: number }): Promise<Quote> {
    const hours = Math.ceil(candidate.hours);
    const osId = osIdFor(candidate.offer.provider);
    const body = JSON.stringify({
      plan: candidate.offer.id,
      region,
      ...(osId === undefined ? {} : { os_id: osId }),
      label: LABEL,
      prepaid_hours: hours,
      ssh_public_key: opts.sshPublicKey,
      network: "solana",
      max_total_usd: opts.maxTotalUsd,
    });

    let response: Response;
    let text: string;
    try {
      response = await this.postProvision(body);
      text = await readTextCapped(response);
    } catch (e) {
      throw new QuoteError("UNREACHABLE", `${this.config.label} could not be reached: ${errText(e)}.`);
    }

    if (response.status !== 402) {
      const refusal = this.refusal(response.status, text);
      throw new QuoteError(refusal.code, refusal.detail);
    }
    const required = readPaymentRequired(response, text);
    const req = required ? solanaRequirement(required) : null;
    if (!req) throw new QuoteError("NO_402", `${this.config.label} asked for payment but did not say how to pay on Solana.`);
    const accepts = toAccepts(req);
    return {
      seller: this.config.id,
      market: this.config.market,
      candidate,
      region,
      hours,
      amountUsd: atomicToUsd(accepts.amount),
      atomic: accepts.amount,
      accepts,
      body,
    };
  }

  /** Why an unpaid request did not return a 402. */
  private refusal(status: number, text: string): { code: "PRICE_CAP" | "OUT_OF_STOCK" | "SELLER_ERROR"; detail: string } {
    const body = parseJson(text);
    if (status === 409 && isObj(body) && "quote_usd" in body) return { code: "PRICE_CAP", detail: this.priceCap(body.quote_usd, "asks") };
    if (status >= 400 && STOCK_RE.test(text)) return { code: "OUT_OF_STOCK", detail: `${this.config.label} could not sell it (error ${status}): ${said(text)}` };
    return { code: "SELLER_ERROR", detail: `${this.config.label} refused the request (error ${status}): ${said(text)}` };
  }

  private priceCap(quoteUsd: unknown, verb: "asks" | "now asks"): string {
    const n = Number(str(quoteUsd));
    const price = str(quoteUsd) !== "" && Number.isFinite(n) ? usdPlain(n) : "a price";
    return `${this.config.label} ${verb} ${price}, more than your budget allows.`;
  }

  /**
   * Signs at most one payment per call. After the paid request is sent, failures resend
   * the identical request (same payment headers) and never call `pay` again.
   */
  async provision(quote: Quote, pay: PayFn): Promise<ProvisionOutcome> {
    // 1. fresh 402 for the same body
    let fresh: Response;
    let freshText: string;
    try {
      fresh = await this.postProvision(quote.body);
      freshText = await readTextCapped(fresh);
    } catch (e) {
      return { kind: "not_charged", code: "SELLER_ERROR", detail: `${this.config.label} could not be reached: ${errText(e)}.` };
    }
    if (fresh.status !== 402) return { kind: "not_charged", ...this.refusal(fresh.status, freshText) };
    const required = readPaymentRequired(fresh, freshText);
    const req = required ? solanaRequirement(required) : null;
    if (!required || !req) {
      return { kind: "not_charged", code: "SELLER_ERROR", detail: `${this.config.label} asked for payment but did not say how to pay on Solana.` };
    }

    // 2. the only call to pay; it signs for exactly the requirement the guard sees
    let headers: Record<string, string>;
    try {
      const result = await pay({ ...required, accepts: [req] }, toAccepts(req));
      if (typeof result === "object" && result !== null && "refused" in result) {
        return { kind: "not_charged", code: "REFUSED_BY_GUARD", detail: String((result as { refused: unknown }).refused).slice(0, 200) };
      }
      headers = result as Record<string, string>;
    } catch (e) {
      return { kind: "not_charged", code: "SELLER_ERROR", detail: `The payment could not be signed: ${errText(e)}.` };
    }

    // 3. paid request, resent unchanged on 5xx or network failure
    let last = "";
    for (let attempt = 1; attempt <= PAID_ATTEMPTS; attempt++) {
      if (attempt > 1) await this.sleep(RETRY_DELAY_MS);
      let response: Response;
      let text: string;
      try {
        response = await this.postProvision(quote.body, headers);
        text = await readTextCapped(response);
      } catch (e) {
        // an answer too large to read is like an unreadable one: the payment may have gone through
        if (e instanceof TooLargeError) return { kind: "unknown", detail: `${this.config.label} answered the paid request with more than 2 MB, which the agent does not read; it will not pay again.` };
        last = `no answer: ${errText(e)}`;
        continue;
      }
      if (response.status >= 500) {
        last = `error ${response.status}, ${sellerReason(text)}`;
        continue;
      }
      return this.paidOutcome(response, text);
    }
    return { kind: "unknown", detail: `${this.config.label} did not give a clear answer to the paid request after ${PAID_ATTEMPTS} tries (last: ${last}).` };
  }

  private paidOutcome(response: Response, text: string): ProvisionOutcome {
    const status = response.status;
    const body = parseJson(text);
    const obj = isObj(body) ? body : {};
    if (status === 200 || status === 201 || status === 202) {
      const instance = toInstance(obj.order);
      if (!instance) return { kind: "unknown", detail: `${this.config.label} accepted the paid request but sent back no machine order.` };
      const active = status !== 202 && instance.status === "active" && instance.ip !== null;
      return { kind: active ? "active" : "pending", instance, tx: txFrom(obj, response) };
    }
    if (status === 409 && text.includes("settlement_pending")) {
      return { kind: "unknown", detail: `${this.config.label} says the payment is still settling; the agent will not pay again.` };
    }
    if (status === 409 && "quote_usd" in obj) {
      return { kind: "not_charged", code: "PRICE_CAP", detail: this.priceCap(obj.quote_usd, "now asks") };
    }
    if (status === 402) return { kind: "not_charged", code: "PAYMENT_REJECTED", detail: `${this.config.label} said the payment was not accepted: ${said(text)}` };
    return { kind: "unknown", detail: `${this.config.label} gave an unexpected answer to the paid request (error ${status}): ${said(text)}` };
  }

  private async signed(method: "GET" | "DELETE", path: string): Promise<{ response: Response; text: string }> {
    if (!this.signer) throw new Error(NO_WALLET);
    const headers = await authHeaders(this.signer, { method, path, body: "", now: this.now });
    const signal = AbortSignal.timeout(method === "DELETE" ? this.timeouts.paid : this.timeouts.read);
    const response = await this.fetch(this.url(path), { method, headers: { Accept: "application/json", ...headers }, signal });
    return { response, text: await readTextCapped(response) };
  }

  async instance(id: string): Promise<Instance | null> {
    const { response, text } = await this.signed("GET", `/compute/instances/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${this.config.label} could not show machine ${id} (error ${response.status}): ${said(text)}`);
    const body = parseJson(text);
    const raw = isObj(body) && isObj(body.instance) ? body.instance : isObj(body) && isObj(body.order) ? body.order : body;
    return toInstance(raw);
  }

  async instances(): Promise<Instance[]> {
    const { response, text } = await this.signed("GET", "/compute/instances");
    if (!response.ok) throw new Error(`${this.config.label} could not list your machines (error ${response.status}): ${said(text)}`);
    const body = parseJson(text);
    const rows = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.instances) ? body.instances : isObj(body) && Array.isArray(body.orders) ? body.orders : null;
    if (!rows) throw new Error(`${this.config.label}'s machine list has an unexpected shape.`);
    return rows.map(toInstance).filter((i): i is Instance => i !== null);
  }

  async destroy(id: string): Promise<void> {
    const { response, text } = await this.signed("DELETE", `/compute/instances/${encodeURIComponent(id)}`);
    if (response.ok || response.status === 404) return;
    throw new Error(`${this.config.label} could not destroy machine ${id} (error ${response.status}): ${said(text)}`);
  }
}
