import { didKeyToJwk, type TransparencyLogDirectory } from "../ans";
import type { AuditDeps } from "../auditor";
import { receiptVerifier } from "../x402";

export const DEFAULT_AUDITOR = "ans://v1.0.0.auditor.burn402.xyz";
export const DEFAULT_BROKER = "ans://v1.0.0.broker.burn402.xyz";

export function rootKeysFor(iss: string) {
  return Promise.resolve(iss.startsWith("did:key:") ? [didKeyToJwk(iss)] : []);
}

export function publicAuditDeps(directory: TransparencyLogDirectory, trustedBrokers: readonly string[] = [DEFAULT_BROKER]): AuditDeps {
  return {
    resolveAgentKeys: (iss) => directory.resolveKeys(iss),
    resolveRootKeys: rootKeysFor,
    isAnchored: (iss) => directory.isAnchored(iss),
    verifyReceipt: receiptVerifier((iss) => directory.resolveKeys(iss), trustedBrokers),
  };
}
