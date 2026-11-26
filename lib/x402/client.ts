const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(input: string): Uint8Array {
  let n = BigInt(0);
  for (const ch of input) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("invalid base58 character");
    n = n * BigInt(58) + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros++;
  return new Uint8Array([...new Uint8Array(zeros), ...Buffer.from(n === BigInt(0) ? "" : hex, "hex")]);
}
