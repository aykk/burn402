/**
 * Whether a failed verifier step means "the network did not answer" rather than "the record failed".
 *
 * Step details can carry attacker-influenced text, so a detail alone must never decide this: only the
 * steps that fetch from the gateway can be unreachable, and only when the WHOLE detail is one of the
 * exact shapes those fetches produce. Signature (and every other) step is never unreachable.
 *
 * Proper fix: a structured `kind` on each verifier step in lib/verify, instead of matching names and
 * text here. That is out of scope for this UI change.
 */
export const FETCH_STEPS: ReadonlySet<string> = new Set(["arweave item", "verdict record", "conversation record"]);

const UNREACHABLE_DETAIL =
  /^(?:fetch failed|fetch \S+: HTTP \d{3}|not found on the gateway|(?:connect )?(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_\w+)|socket hang up|The operation was aborted|The operation timed out|NetworkError when attempting to fetch resource\.?)$/i;

export function isUnreachable(step: { name: string; detail: string }): boolean {
  return FETCH_STEPS.has(step.name) && UNREACHABLE_DETAIL.test(step.detail.trim());
}
