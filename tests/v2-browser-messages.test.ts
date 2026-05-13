import { describe, expect, it } from "vitest";
import { v2ProjectionMessageFromRow } from "../src/client/v2-browser-messages";

describe("v2 browser worker messages", () => {
  it("builds projection messages only from well-shaped cached rows", () => {
    const row = {
      scope: "#room",
      head: {
        kind: "woo.scope_head.shadow.v1",
        scope: "#room",
        epoch: 1,
        seq: 3,
        hash: "head-3"
      },
      projection: {
        kind: "woo.scope_projection.shadow.v1",
        scope: "#room",
        contents: []
      }
    };

    expect(v2ProjectionMessageFromRow(row, { cached: true })).toEqual({
      kind: "projection",
      scope: "#room",
      head: row.head,
      projection: row.projection,
      cached: true
    });
    expect(v2ProjectionMessageFromRow({ ...row, head: { seq: "3" } })).toBeUndefined();
    expect(v2ProjectionMessageFromRow({ ...row, scope: 123 })).toBeUndefined();
  });
});
