import type { BurnEvent } from "../burn";
import type { DelegationEvent } from "../mandate";
import type { GateEvent } from "../x402";

export type LogKind = "info" | "step" | "accepted" | "refused" | "paid" | "provisioned" | "breach" | "verdict" | "anchor" | "trust" | "reaper" | "error";

export type LogLine = {
  seq: number;
  at: number;
  kind: LogKind;
  code: string;
  text: string;
  link?: { label: string; href: string };
};

const short = (hash: string | null | undefined) => (hash ? `${hash.slice(0, 13)}..` : "-");

export class DemoLog {
  readonly lines: LogLine[] = [];
  private seq = 0;

  push(kind: LogKind, code: string, text: string, link?: LogLine["link"]): void {
    this.lines.push({ seq: ++this.seq, at: Date.now(), kind, code, text, link });
    if (process.env.BURN402_LOG_TO_TERMINAL !== "0") {
      process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${code.padEnd(20)} ${text}${link ? `  ${link.href}` : ""}\n`);
    }
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500);
  }

  info(text: string): void {
    this.push("info", "INFO", text);
  }

  fromDelegation(e: DelegationEvent): void {
    if (e.type === "DELEGATION_ACCEPTED") {
      this.push(
        "accepted",
        e.type,
        `${e.child_jti} depth ${e.depth} limit ${e.limit_usd.toFixed(3)}${e.parent_remaining_usd === null ? " (root)" : ` against parent remaining ${e.parent_remaining_usd.toFixed(3)}`}  ${short(e.hash)}`,
      );
    } else {
      this.push("refused", e.type, `${e.child_jti ?? "?"} rule ${e.rule} ${e.code}: ${e.detail}`);
    }
  }

  fromBurn(e: BurnEvent): void {
    switch (e.type) {
      case "PROVISION_REFUSED":
        return this.push("refused", e.type, `${e.plan} ${e.code}: ${e.detail}`);
      case "PROVISION_FAILED":
        return this.push("error", e.type, `${e.plan}: ${e.detail}`);
      case "RESOURCE_PROVISIONED":
        return this.push("provisioned", e.type, `${e.handle} ${e.plan} at ${e.hourly_usd.toFixed(3)}/hr, effective_exp ${new Date(e.effective_exp * 1000).toISOString().slice(11, 19)}Z`);
      case "RESOURCE_REAPED":
        return this.push("reaper", e.type, `${e.handle} destroyed: ${e.reason}, charged ${e.charged_usd.toFixed(6)} of mandate ${short(e.mandate)}`);
      case "RESOURCE_RELEASED":
        return this.push("info", e.type, `${e.handle} released, charged ${e.charged_usd.toFixed(6)}`);
    }
  }

  fromGate(e: GateEvent): void {
    switch (e.type) {
      case "PAYMENT_REQUIRED":
        return this.push("info", "402", `payment required: ${e.usd.toFixed(6)} USDC for ${e.plan}`);
      case "PAYMENT_SETTLED":
        return this.push("paid", e.type, `${e.usd.toFixed(6)} USDC settled for ${e.handle}`, {
          label: `tx ${e.tx.slice(0, 10)}..`,
          href: `https://explorer.solana.com/tx/${e.tx}?cluster=devnet`,
        });
      case "PAYMENT_REJECTED":
        return this.push("refused", e.type, e.reason);
      case "SETTLEMENT_FAILED":
        return this.push("error", e.type, `${e.reason}; destroyed ${e.destroyed}`);
      case "REQUEST_REJECTED":
        return this.push("refused", `HTTP ${e.status}`, e.reason);
      case "TRANSACTION":
        return this.push(e.record.outcome === "accepted" ? "paid" : "refused", "TRANSACTION", `${e.record.subject} ${e.record.plan}: ${e.record.outcome}${e.record.reason ? ` (${e.record.reason})` : ""}`);
    }
  }
}
