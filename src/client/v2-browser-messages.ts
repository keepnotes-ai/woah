import { isShadowScopeHead, type ShadowScopeHead } from "../core/shadow-scope-head";
import type { WooValue } from "../core/types";

export type V2ProjectionRow = {
  scope: string;
  head: unknown;
  projection: unknown;
  updated_at?: number;
};

export type V2ProjectionMessage = {
  kind: "projection";
  scope: string;
  head: ShadowScopeHead;
  projection: WooValue;
  cached?: boolean;
};

export function v2ProjectionMessageFromRow(row: unknown, options: { cached?: boolean } = {}): V2ProjectionMessage | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const record = row as Partial<V2ProjectionRow>;
  if (typeof record.scope !== "string" || !isShadowScopeHead(record.head)) return undefined;
  return {
    kind: "projection",
    scope: record.scope,
    head: record.head,
    projection: record.projection as WooValue,
    ...(options.cached ? { cached: true } : {})
  };
}
