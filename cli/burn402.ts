import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRootKeys } from "../lib/ans";
import { APP_NAME, SCHEMA, TurboGateway, type Network } from "../lib/anchor";
import { DEFAULT_AUDITOR, DEFAULT_BROKER, verifyAnchoredVerdict, type VerifyReport } from "../lib/verify";

type Flags = Record<string, string | boolean>;

function parse(argv: string[]): { command: string | undefined; args: string[]; flags: Flags } {
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      args.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) flags[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return { command: args.shift(), args, flags };
}

function str(flags: Flags, key: string, fallback: string): string {
  const v = flags[key];
  return typeof v === "string" ? v : fallback;
}

function list(flags: Flags, key: string, fallback: string): string[] {
  return str(flags, key, fallback).split(",").filter(Boolean);
}

function dots(label: string, width = 26): string {
  return `${label} ${".".repeat(Math.max(2, width - label.length))}`;
}

function short(hash: string): string {
  return hash.startsWith("sha256:") ? `${hash.slice(0, 13)}..` : hash;
}

function print(report: VerifyReport): void {
  const out = (line = "") => process.stdout.write(`${line}\n`);
  out(`burn402 verify ${report.txid}`);
  for (const s of report.steps) out(`${dots(s.name)} ${s.ok ? "ok" : "FAIL"}  ${s.detail}`);
  if (report.chain.length > 0) {
    out();
    for (const c of report.chain) {
      out(`chain[${c.depth}] ${short(c.hash)}  ${c.jti.padEnd(14)} ${c.iss} -> ${c.sub}  limit ${c.limit_usd.toFixed(2)}  rate ${c.rate_usd_hr.toFixed(2)}/hr`);
    }
  }
  const v = report.verdict;
  if (v) {
    out();
    for (const c of v.checks) out(`  ${c.result.padEnd(4)} ${c.id.padEnd(18)} ${c.detail ?? ""}`);
    out();
    out(`verdict: ${v.verdict}${v.failure_mode ? `  ${v.failure_mode}` : ""}  ${report.ok ? "(reproduced)" : "(NOT reproduced)"}`);
    out(`subject: ${v.subject}  history key: ${v.fqdn}`);
  }
  if (report.mismatches.length > 0) out(`mismatched fields: ${report.mismatches.join(", ")}`);
}

function gateway(flags: Flags): TurboGateway {
  const network = str(flags, "network", "testnet") as Network;
  if (network !== "testnet" && network !== "production") throw new Error("--network must be testnet or production");
  return new TurboGateway({ network, gatewayUrl: typeof flags.gateway === "string" ? flags.gateway : undefined });
}

async function main(argv: string[]): Promise<number> {
  const { command, args, flags } = parse(argv);
  const rootKeys = parseRootKeys(readFileSync(str(flags, "tl-root-keys", join(process.cwd(), "config", "ans", "tl-root-keys.txt")), "utf8"));
  const trustedAuditors = list(flags, "auditor", DEFAULT_AUDITOR);
  const trustedBrokers = list(flags, "broker", DEFAULT_BROKER);

  if (command === "verify" && args[0]) {
    const report = await verifyAnchoredVerdict({ gateway: gateway(flags), txid: args[0], tlRootKeys: rootKeys, trustedAuditors, trustedBrokers });
    if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else print(report);
    return report.ok ? 0 : 1;
  }

  if (command === "history" && args[0]) {
    const gw = gateway(flags);
    const items = await gw.query([
      { name: "App-Name", value: APP_NAME },
      { name: "Schema", value: SCHEMA },
      { name: "Subject-FQDN", value: args[0] },
    ]);
    process.stdout.write(`history for ${args[0]}: ${items.length} record${items.length === 1 ? "" : "s"} tagged\n`);
    let verified = 0;
    for (const item of items) {
      const report = await verifyAnchoredVerdict({ gateway: gw, txid: item.id, tlRootKeys: rootKeys, trustedAuditors, trustedBrokers });
      const v = report.verdict;
      if (report.ok && v) verified++;
      process.stdout.write(
        `  ${item.id}  ${report.ok ? "verified" : "REJECTED"}  ${v ? `${v.verdict} ${v.failure_mode ?? ""} ${v.subject} @${v.issued_at}` : report.steps.at(-1)?.detail ?? ""}\n`,
      );
    }
    process.stdout.write(`${verified} verified breach record${verified === 1 ? "" : "s"}\n`);
    return 0;
  }

  process.stdout.write(
    [
      "usage:",
      "  burn402 verify <arweave-txid> [--network testnet|production] [--json]",
      "  burn402 history <fqdn> [--network testnet|production]",
      "options:",
      "  --tl-root-keys <file>   pinned ANS transparency log root keys (default config/ans/tl-root-keys.txt)",
      `  --auditor <ans,...>     trusted auditors (default ${DEFAULT_AUDITOR})`,
      `  --broker <ans,...>      trusted brokers (default ${DEFAULT_BROKER})`,
      "",
    ].join("\n"),
  );
  return command ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  },
);
