import { createHash, randomBytes } from "node:crypto";

export function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function randomHex(byteLength: number): string {
  return randomBytes(byteLength).toString("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
