export type AnsErrorCode =
  | "MALFORMED_COSE"
  | "UNKNOWN_TL_KEY"
  | "BAD_TL_SIGNATURE"
  | "BAD_INCLUSION_PROOF"
  | "NOT_IN_DIRECTORY"
  | "NAME_MISMATCH"
  | "AGENT_NOT_ACTIVE"
  | "STATUS_EXPIRED"
  | "IDENTITY_NOT_LINKED"
  | "UNSUPPORTED_IDENTITY"
  | "TL_UNAVAILABLE";

export class AnsError extends Error {
  readonly code: AnsErrorCode;

  constructor(code: AnsErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "AnsError";
    this.code = code;
  }
}
