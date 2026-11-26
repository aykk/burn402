import type { DelegationEvent } from "../mandate";

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
}
