import { describe, expect, it } from "vitest";
import { elapsedText, usd2, usd4 } from "./format";

describe("money formats", () => {
  it("keep their decimals", () => {
    expect(usd2(1)).toBe("$1.00");
    expect(usd2(0.125)).toBe("$0.125");
    expect(usd4(0.010382)).toBe("$0.0104");
  });
  it("large amounts get thousands separators", () => {
    expect(usd2(99999999)).toBe("$99,999,999.00");
    expect(usd2(1234.5)).toBe("$1,234.50");
    expect(usd4(1234567.25)).toBe("$1,234,567.2500");
    expect(usd4(999)).toBe("$999.0000");
  });
});

describe("elapsedText", () => {
  it("reads as people say it", () => {
    expect(elapsedText(51)).toBe("51 s");
    expect(elapsedText(51.4)).toBe("51 s");
    expect(elapsedText(125)).toBe("2 min 5 s");
    expect(elapsedText(600)).toBe("10 min");
    expect(elapsedText(3600 + 5 * 60 + 9)).toBe("1 h 5 min");
    expect(elapsedText(7200)).toBe("2 h");
    expect(elapsedText(Number.NaN)).toBe("-");
  });
});
