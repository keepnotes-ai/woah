import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { encodeEnvelope } from "../../src/core/shadow-envelope";
import {
  createShadowBrowserNode,
  createShadowBrowserRelayShim,
  openShadowBrowserScope,
  setShadowBrowserSessionToken,
  shadowBrowserEnvelope
} from "../../src/core/shadow-browser-node";
import { runShadowTurnCall, type ShadowTurnCall } from "../../src/core/shadow-turn-call";
import { shadowTurnKeyFromTranscript } from "../../src/core/turn-key";
import type { WooWorld } from "../../src/core/world";
import { CommitScopeDO } from "../../src/worker/commit-scope-do";
import { DirectoryDO } from "../../src/worker/directory-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";

vi.setConfig({ testTimeout: 120_000 });

class FakeSqlCursor {
  constructor(private readonly rows: Record<string, unknown>[]) {}

  toArray(): Record<string, unknown>[] {
    return this.rows;
  }

  [Symbol.iterator](): Iterator<Record<string, unknown>> {
    return this.rows[Symbol.iterator]();
  }
}

class FakeSqlStorage {
  readonly execLog: Array<{ query: string; changes: number }> = [];

  constructor(private readonly db: DatabaseSync) {}

  exec(query: string, ...params: unknown[]): FakeSqlCursor {
    const stmt = this.db.prepare(query);
    const head = query.trim().split(/\s+/, 1)[0]?.toUpperCase();
    if (head === "SELECT" || head === "PRAGMA") {
      this.execLog.push({ query, changes: 0 });
      return new FakeSqlCursor(stmt.all(...(params as any[])) as Record<string, unknown>[]);
    }
    const result = stmt.run(...(params as any[])) as { changes?: number };
    this.execLog.push({ query, changes: Number(result.changes ?? 0) });
    return new FakeSqlCursor([]);
  }
}

class FakeDurableObjectState {
  readonly id: { name: string };
  private readonly db = new DatabaseSync(":memory:");
  private transactionDepth = 0;
  private savepointCounter = 0;

  constructor(name = "world") {
    this.id = { name };
  }

  readonly storage = {
    sql: new FakeSqlStorage(this.db),
    transactionSync: <T>(fn: () => T): T => this.transactionSync(fn)
  };

  close(): void {
    this.db.close();
  }

  private transactionSync<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      const name = `fake_v2_cost_sp_${++this.savepointCounter}`;
      this.db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
        throw err;
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.transactionDepth = 0;
    }
  }
}

class CountingDurableObjectNamespace {
  fetchCallCount = 0;

  constructor(private readonly factory: (name: string) => { fetch(request: Request): Promise<Response> | Response }) {}

  idFromName(name: string): { name: string } {
    return { name };
  }

  get(id: { name: string }): { fetch(request: Request): Promise<Response> | Response } {
    const target = this.factory(id.name);
    return {
      fetch: async (request: Request): Promise<Response> => {
        this.fetchCallCount += 1;
        return await target.fetch(request);
      }
    };
  }
}

class FakeWebSocket {
  readonly sent: string[] = [];

  constructor(private readonly attachment: Record<string, unknown>) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

type CostHarness = {
  world: WooWorld;
  internals: {
    webSocketV2TurnNetworkMessage: (world: WooWorld, ws: WebSocket, message: string | ArrayBuffer) => Promise<void>;
  };
  ws: FakeWebSocket;
  scopeState: FakeDurableObjectState;
  commitScopeNamespace: CountingDurableObjectNamespace;
  openScope: () => Promise<void>;
  envelope: (index: number) => Promise<string>;
  sendTurn: (index: number) => Promise<void>;
  cleanup: () => void;
};

describe("v2 CommitScopeDO cost budget", () => {
  it("keeps one authority-bearing envelope inside the per-turn write and invocation budget", async () => {
    const harness = await makeCostHarness();
    try {
      await harness.openScope();
      resetCostLog(harness);

      await harness.sendTurn(1);

      const writes = rowWrites(harness.scopeState);
      // Expected row writes for one committed turn:
      // meta + accepted_frame + transcript_tail + seen + reply = 5.
      // Budget allows two small retention/accounting additions, but rejects the
      // old retained-tail rewrite pattern that produced thousands of writes.
      expect(writes).toBeLessThanOrEqual(7);
      expect(writeRowsByTable(harness.scopeState)).toMatchObject({
        v2_commit_scope_meta: 1,
        v2_commit_scope_accepted_frame: 1,
        v2_commit_scope_transcript_tail: 1,
        v2_commit_scope_seen: 1,
        v2_commit_scope_reply: 1
      });
      // One browser envelope should cross exactly one extra Durable Object
      // boundary: gateway -> CommitScopeDO. Extra hops are billing-visible.
      expect(harness.commitScopeNamespace.fetchCallCount).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps cold-start plus first envelope inside the write budget", async () => {
    const harness = await makeCostHarness();
    try {
      await harness.openScope();
      await harness.sendTurn(1);

      // Cold scope initialization does CREATE TABLE IF NOT EXISTS work, but DDL
      // changes no rows in this harness. Expected row writes are open meta (1)
      // plus the first committed turn (5). Budget 10 catches any return to
      // full retained-row save() on the first envelope after wake.
      expect(rowWrites(harness.scopeState)).toBeLessThanOrEqual(10);
    } finally {
      harness.cleanup();
    }
  });

  it("performs exactly zero durable writes on duplicate envelope replay", async () => {
    const harness = await makeCostHarness();
    try {
      await harness.openScope();
      const envelope = await harness.envelope(1);
      await harness.internals.webSocketV2TurnNetworkMessage(harness.world, harness.ws as unknown as WebSocket, envelope);
      const writesBeforeReplay = rowWrites(harness.scopeState);

      await harness.internals.webSocketV2TurnNetworkMessage(harness.world, harness.ws as unknown as WebSocket, envelope);

      // Duplicate replay must be reply-idempotent and storage-idempotent. If
      // this changes, retries can revive the same cost cliff as executing a
      // fresh turn, even though the side effect is correctly deduped.
      expect(rowWrites(harness.scopeState)).toBe(writesBeforeReplay);
    } finally {
      harness.cleanup();
    }
  });

  it("scales write cost linearly across many turns", async () => {
    const harness = await makeCostHarness();
    try {
      await harness.openScope();
      resetCostLog(harness);

      for (let index = 1; index <= 20; index += 1) await harness.sendTurn(index);
      const writesAfterFirstBatch = rowWrites(harness.scopeState);
      for (let index = 21; index <= 40; index += 1) await harness.sendTurn(index);
      const writesAfterSecondBatch = rowWrites(harness.scopeState);
      const secondBatchPerTurn = (writesAfterSecondBatch - writesAfterFirstBatch) / 20;

      // Expected remains about 5 writes/turn regardless of retained tail size.
      // O(retained) rewrites grow this number as history accumulates.
      expect(secondBatchPerTurn).toBeLessThanOrEqual(7);
    } finally {
      harness.cleanup();
    }
  });
});

async function makeCostHarness(): Promise<CostHarness> {
  const directoryState = new FakeDurableObjectState("directory");
  const gatewayState = new FakeDurableObjectState("world");
  const scopeState = new FakeDurableObjectState("#-1");
  const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
  const commitScope = new CommitScopeDO(scopeState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
  const commitScopeNamespace = new CountingDurableObjectNamespace((name) => {
    if (name !== "#-1") throw new Error(`unexpected CommitScopeDO ${name}`);
    return commitScope;
  });
  const env = {
    WOO_INITIAL_WIZARD_TOKEN: "cf-v2-cost-token",
    WOO_INTERNAL_SECRET: "cf-test-secret",
    WOO_AUTO_INSTALL_CATALOGS: "",
    DIRECTORY: new CountingDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected DirectoryDO ${name}`);
      return directory;
    }),
    WOO: new CountingDurableObjectNamespace((name) => {
      throw new Error(`unexpected Woo DO ${name}`);
    }),
    COMMIT_SCOPE: commitScopeNamespace
  } as unknown as Env;
  const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
  const internals = gateway as unknown as CostHarness["internals"];
  const world = createWorld();
  const session = world.auth("guest:cf-v2-cost");
  world.createObject({ id: "cf_v2_cost_box", name: "V2 Cost Box", parent: "$thing", owner: session.actor });
  world.defineProperty("cf_v2_cost_box", { name: "value", defaultValue: 0, owner: session.actor, perms: "rw", typeHint: "int" });
  expect(installVerb(world, "cf_v2_cost_box", "set_value", `verb :set_value(value) rxd {
    this.value = value;
    return this.value;
  }`, null).ok).toBe(true);

  const relay = createShadowBrowserRelayShim({
    node: "node:commit-scope:#-1",
    scope: "#-1",
    serialized: world.exportWorld()
  });
  const browser = createShadowBrowserNode({
    node: "browser:v2-cost",
    scope: "#-1",
    actor: session.actor,
    session: session.id,
    relay
  });
  setShadowBrowserSessionToken(browser, "guest:cf-v2-cost");
  await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
  const ws = new FakeWebSocket({
    protocol: "v2-turn-network",
    sessionId: session.id,
    actor: session.actor,
    socketId: "v2-cost-socket",
    node: "browser:v2-cost",
    scope: "#-1",
    token: "guest:cf-v2-cost"
  });

  return {
    world,
    internals,
    ws,
    scopeState,
    commitScopeNamespace,
    openScope: async () => {
      const request = await signInternalRequest(env, new Request("https://woo.internal/v2/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "#-1",
          node: "browser:v2-cost",
          token: "guest:cf-v2-cost",
          session: session.id,
          actor: session.actor,
          sessions: world.exportSessions(),
          serialized: world.exportWorld()
        })
      }));
      const response = await commitScopeNamespace.get(commitScopeNamespace.idFromName("#-1")).fetch(request);
      expect(response.ok).toBe(true);
    },
    envelope: thisEnvelope,
    sendTurn: async (index: number) => {
      await internals.webSocketV2TurnNetworkMessage(world, ws as unknown as WebSocket, await thisEnvelope(index));
    },
    cleanup: () => {
      directoryState.close();
      gatewayState.close();
      scopeState.close();
    }
  };

  async function thisEnvelope(index: number): Promise<string> {
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: `cf-v2-cost-value-${index}`,
      route: "direct",
      scope: "#-1",
      session: session.id,
      actor: session.actor,
      target: "cf_v2_cost_box",
      verb: "set_value",
      args: [67]
    };
    const planned = await runShadowTurnCall(browser.relay.commit_scope.serialized, call);
    const request = {
      kind: "woo.turn.exec.request.shadow.v1" as const,
      id: call.id,
      call,
      key: shadowTurnKeyFromTranscript(planned.transcript),
      expected: browser.relay.commit_scope.head,
      commit_policy: "execute_and_commit" as const
    };
    return encodeEnvelope(shadowBrowserEnvelope(browser, request.kind, request, `cf-v2-cost-env-${index}`));
  }
}

function resetCostLog(harness: CostHarness): void {
  harness.scopeState.storage.sql.execLog.length = 0;
  harness.commitScopeNamespace.fetchCallCount = 0;
}

function rowWrites(state: FakeDurableObjectState): number {
  return state.storage.sql.execLog
    .filter((entry) => /^(INSERT|UPDATE|DELETE)\b/i.test(entry.query.trim()))
    .reduce((total, entry) => total + entry.changes, 0);
}

function writeRowsByTable(state: FakeDurableObjectState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of state.storage.sql.execLog) {
    if (!/^(INSERT|UPDATE|DELETE)\b/i.test(entry.query.trim())) continue;
    const table = writeTable(entry.query);
    if (!table) continue;
    counts[table] = (counts[table] ?? 0) + entry.changes;
  }
  return counts;
}

function writeTable(query: string): string | null {
  const normalized = query.trim();
  return normalized.match(/^INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+([a-zA-Z0-9_]+)/i)?.[1]
    ?? normalized.match(/^UPDATE\s+([a-zA-Z0-9_]+)/i)?.[1]
    ?? normalized.match(/^DELETE\s+FROM\s+([a-zA-Z0-9_]+)/i)?.[1]
    ?? null;
}
