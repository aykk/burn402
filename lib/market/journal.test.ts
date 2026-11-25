import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Journal, type JournalEntry, type JournalEvent } from "./journal";

let file: string;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "journal-")), "sub", "purchases.jsonl");
});

let t = 0;
const e = (run: string, event: JournalEvent, extra: Partial<JournalEntry> = {}): JournalEntry => ({
  at: ++t,
  run,
  market: "test",
  seller: "s1",
  event,
  plan: "p1",
  region: "us",
  usd: 0.01,
  ...extra,
});

describe("Journal", () => {
  it("round-trips entries and creates the directory", () => {
    const j = new Journal(file);
    const a = e("r1", "intent");
    j.append(a);
    expect(j.all()).toEqual([a]);
  });

  it("skips corrupt lines", () => {
    const j = new Journal(file);
    j.append(e("r1", "intent"));
    fs.appendFileSync(file, "{not json\n\n");
    j.append(e("r1", "paid"));
    expect(j.all().map((x) => x.event)).toEqual(["intent", "paid"]);
  });

  it("keeps the next entry after a cut-off last line", () => {
    const j = new Journal(file);
    j.append(e("r1", "intent"));
    fs.appendFileSync(file, '{"at":5,"run":"r2","ev'); // torn write, no newline
    j.append(e("r3", "intent"));
    expect(j.hasPayment("r3")).toBe(true);
    expect(j.all().map((x) => x.run)).toEqual(["r1", "r3"]);
  });

  it("reports intent only as unknown", () => {
    const j = new Journal(file);
    j.append(e("r1", "intent"));
    expect(j.open()).toMatchObject([{ run: "r1", state: "unknown", instance: null, tx: null }]);
  });

  it("reports intent, paid, active as active with the instance", () => {
    const j = new Journal(file);
    j.append(e("r1", "intent"));
    j.append(e("r1", "paid", { tx: "sig1" }));
    j.append(e("r1", "active", { instance: "i-9" }));
    expect(j.open()).toMatchObject([{ run: "r1", state: "active", instance: "i-9", tx: "sig1", usd: 0.01, plan: "p1" }]);
  });

  it("reports paid and unknown latest states", () => {
    const j = new Journal(file);
    j.append(e("a", "intent"));
    j.append(e("a", "paid", { tx: "x" }));
    j.append(e("b", "intent"));
    j.append(e("b", "unknown"));
    expect(j.open().map((o) => [o.run, o.state])).toEqual([
      ["a", "paid"],
      ["b", "unknown"],
    ]);
  });

  it("drops released runs", () => {
    const j = new Journal(file);
    for (const ev of ["intent", "paid", "active", "released"] as const) j.append(e("r1", ev));
    expect(j.open()).toEqual([]);
  });

  it("drops failed runs", () => {
    const j = new Journal(file);
    j.append(e("r1", "intent"));
    j.append(e("r1", "failed"));
    expect(j.open()).toEqual([]);
  });

  it("keeps other runs open when one finishes", () => {
    const j = new Journal(file);
    j.append(e("a", "intent"));
    j.append(e("b", "intent"));
    j.append(e("a", "failed"));
    expect(j.open().map((o) => o.run)).toEqual(["b"]);
  });

  it("hasPayment is true once an intent exists", () => {
    const j = new Journal(file);
    expect(j.hasPayment("r1")).toBe(false);
    j.append(e("r1", "intent"));
    expect(j.hasPayment("r1")).toBe(true);
    expect(j.hasPayment("r2")).toBe(false);
  });

  it("two journals on one file see each other", () => {
    const a = new Journal(file);
    const b = new Journal(file);
    a.append(e("r1", "intent"));
    expect(b.hasPayment("r1")).toBe(true);
    b.append(e("r1", "paid"));
    expect(a.open()[0].state).toBe("paid");
  });

  it("reads nothing from a missing file", () => {
    const j = new Journal(file);
    expect(j.all()).toEqual([]);
    expect(j.open()).toEqual([]);
  });

  it("writes the file with mode 0600", () => {
    const j = new Journal(file);
    j.append(e("r1", "intent"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("entries carry no secret-like keys", () => {
    // @ts-expect-error the entry type has no secret field
    const bad: JournalEntry = { ...e("r1", "intent"), secret: "x" };
    void bad;
    // @ts-expect-error the entry type has no privateKey field
    const bad2: JournalEntry = { ...e("r1", "intent"), privateKey: "x" };
    void bad2;
    const j = new Journal(file);
    j.append(e("r1", "intent"));
    for (const k of Object.keys(j.all()[0])) expect(["secret", "key", "privateKey"]).not.toContain(k);
  });
});
