/** Seller and RPC answers are read up to this size; anything larger is treated as unreadable. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class TooLargeError extends Error {
  constructor() {
    super("the answer was larger than 2 MB");
    this.name = "TooLargeError";
  }
}

/** The body as text, or a TooLargeError once it passes `max` bytes (the rest is not read). */
export async function readTextCapped(response: Response, max = MAX_RESPONSE_BYTES): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    throw new TooLargeError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new TooLargeError();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
