import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope, type ShadowEnvelope } from "../src/core/shadow-envelope";

describe("shadow envelope codec", () => {
  it("round-trips one JSON envelope per frame", () => {
    const envelope: ShadowEnvelope<{ kind: "woo.transport.ping.v1"; now: number }> = {
      v: 2,
      type: "woo.transport.ping.v1",
      id: "ping-1",
      from: "browser-node",
      to: "relay-node",
      auth: { mode: "session", token: "shadow-session:1:guest_1" },
      body: { kind: "woo.transport.ping.v1", now: 123 }
    };

    expect(decodeEnvelope(encodeEnvelope(envelope))).toEqual(envelope);
  });

  it("rejects malformed envelopes before dispatch", () => {
    expect(() => decodeEnvelope("{")).toThrow(/malformed/);
    expect(() => decodeEnvelope(JSON.stringify({ v: 1, type: "woo.transport.ping.v1", id: "x", from: "a", auth: { mode: "session", token: "t" }, body: {} }))).toThrow(/version/);
    expect(() => decodeEnvelope(JSON.stringify({ v: 2, type: "woo.unknown.v1", id: "x", from: "a", auth: { mode: "session", token: "t" }, body: {} }))).toThrow(/unknown/);
    expect(() => decodeEnvelope(JSON.stringify({ v: 2, type: "woo.transport.ping.v1", id: "x", from: "a", body: {} }))).toThrow(/auth/);
    expect(() => decodeEnvelope(JSON.stringify({ v: 2, type: "woo.transport.ping.v1", id: "x", from: "a", auth: { mode: "session" }, body: {} }))).toThrow(/token/);
    expect(() => decodeEnvelope(JSON.stringify({
      v: 2,
      type: "woo.transport.ping.v1",
      id: "x",
      from: "a",
      auth: { mode: "session", token: "t" },
      body: { kind: "woo.transport.pong.v1" }
    }))).toThrow(/kind mismatch/);
  });

  it("rejects oversize frames", () => {
    const oversized = JSON.stringify({
      v: 2,
      type: "woo.transport.ping.v1",
      id: "x",
      from: "a",
      auth: { mode: "session", token: "t" },
      body: "x".repeat(1024 * 1024)
    });

    expect(() => decodeEnvelope(oversized)).toThrow(/too large/);
  });
});
