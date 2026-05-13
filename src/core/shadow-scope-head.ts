import type { ShadowScopeHead } from "./shadow-commit-scope";

export type { ShadowScopeHead } from "./shadow-commit-scope";

export function isShadowScopeHead(value: unknown): value is ShadowScopeHead {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const head = value as Partial<ShadowScopeHead>;
  return head.kind === "woo.scope_head.shadow.v1"
    && typeof head.scope === "string"
    && typeof head.epoch === "number"
    && Number.isInteger(head.epoch)
    && typeof head.seq === "number"
    && Number.isInteger(head.seq)
    && typeof head.hash === "string";
}

export function parseShadowScopeHeadJson(raw: string | null): ShadowScopeHead | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isShadowScopeHead(parsed)) return parsed;
  } catch {
    // Reconnect cursors are advisory. Malformed or stale-schema values should
    // fall back to a projection rather than rejecting an otherwise valid open.
  }
  return undefined;
}
