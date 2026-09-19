export type MandateErrorCode =
  | "MALFORMED_JWS"
  | "MALFORMED_PAYLOAD"
  | "UNSUPPORTED_ALG"
  | "FORBIDDEN_HEADER"
  | "UNKNOWN_KEY"
  | "SIGNATURE_INVALID";

export class MandateError extends Error {
  readonly code: MandateErrorCode;

  constructor(code: MandateErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "MandateError";
    this.code = code;
  }
}
