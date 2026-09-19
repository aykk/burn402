import { MandateError } from "./errors";

export type Mandate = {
  jti: string;
  iss: string;
  sub: string;
  aud: string;
  parent: string | null;
  depth: number;
  max_depth: number;
  scope: string[];
  limit_usd: number;
  rate_usd_hr: number;
  nbf: number;
  exp: number;
};

const FIELDS = [
  "jti",
  "iss",
  "sub",
  "aud",
  "parent",
  "depth",
  "max_depth",
  "scope",
  "limit_usd",
  "rate_usd_hr",
  "nbf",
  "exp",
] as const;

export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ANS_NAME = /^ans:\/\/v\d+\.\d+\.\d+\.[a-z0-9.-]+$/;

function fail(message: string): never {
  throw new MandateError("MALFORMED_PAYLOAD", message);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function nonNegativeInt(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${field} must be a non-negative integer`);
  return value as number;
}

function nonNegativeAmount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${field} must be a non-negative number`);
  return value;
}

export function parseMandate(input: unknown): Mandate {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("payload must be an object");
  const raw = input as Record<string, unknown>;

  const keys = Object.keys(raw);
  const unknown = keys.filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) fail(`unknown fields: ${unknown.join(", ")}`);
  const missing = FIELDS.filter((k) => !(k in raw));
  if (missing.length > 0) fail(`missing fields: ${missing.join(", ")}`);

  const jti = nonEmptyString(raw.jti, "jti");
  const iss = nonEmptyString(raw.iss, "iss");
  const sub = nonEmptyString(raw.sub, "sub");
  const aud = nonEmptyString(raw.aud, "aud");
  if (!ANS_NAME.test(sub)) fail("sub must be an ANS name");
  if (!ANS_NAME.test(aud)) fail("aud must be an ANS name");

  const parent = raw.parent;
  if (parent !== null && (typeof parent !== "string" || !HASH_PATTERN.test(parent))) {
    fail("parent must be null or sha256:<64 hex>");
  }

  const depth = nonNegativeInt(raw.depth, "depth");
  const max_depth = nonNegativeInt(raw.max_depth, "max_depth");
  if ((parent === null) !== (depth === 0)) fail("parent must be null exactly when depth is 0");
  if (depth > max_depth) fail("depth exceeds max_depth");

  if (!Array.isArray(raw.scope) || raw.scope.length === 0) fail("scope must be a non-empty array");
  const scope = raw.scope.map((s, i) => nonEmptyString(s, `scope[${i}]`));
  if (new Set(scope).size !== scope.length) fail("scope entries must be unique");

  const limit_usd = nonNegativeAmount(raw.limit_usd, "limit_usd");
  const rate_usd_hr = nonNegativeAmount(raw.rate_usd_hr, "rate_usd_hr");

  const nbf = nonNegativeInt(raw.nbf, "nbf");
  const exp = nonNegativeInt(raw.exp, "exp");
  if (nbf >= exp) fail("nbf must be before exp");

  return {
    jti,
    iss,
    sub,
    aud,
    parent: parent as string | null,
    depth,
    max_depth,
    scope,
    limit_usd,
    rate_usd_hr,
    nbf,
    exp,
  };
}
