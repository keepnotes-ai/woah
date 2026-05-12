import type { SerializedObject, SerializedWorld } from "./repository";
import { createShadowCommitScope, type ShadowCommitAccepted, type ShadowCommitConflict, type ShadowCommitScope } from "./shadow-commit-scope";
import {
  createShadowExecutionNode,
  installShadowCachedObjectRecords,
  shadowObjectRecordHash,
  type ShadowExecutionNode,
  type ShadowStateTransfer,
  type ShadowTurnExecRequest,
  type ShadowTurnExecutionResult
} from "./shadow-turn-exec";
import { runShadowTurnCall, type ShadowTurnCall } from "./shadow-turn-call";
import { buildShadowTurnExecAd, executeShadowTurnCallAcrossInProcessNetwork, type ShadowInProcessNetworkResult } from "./shadow-turn-network";
import { shadowTurnKeyFromTranscript, type ShadowTurnKey } from "./turn-key";
import type { EffectTranscript } from "./effect-transcript";
import type { ObjRef, Observation, WooValue } from "./types";

export type ShadowLiveAudience = {
  actors?: ObjRef[];
  sessions?: string[];
  scope?: ObjRef;
};

export type ShadowLiveEvent = {
  kind: "woo.live.event.shadow.v1";
  id: string;
  source: ObjRef;
  actor?: ObjRef;
  scope?: ObjRef;
  audience?: ShadowLiveAudience;
  observation: Observation;
  coalesce?: string;
};

export type ShadowBrowserLiveInput = {
  id?: string;
  source: ObjRef;
  actor?: ObjRef;
  scope?: ObjRef;
  audience?: ShadowLiveAudience;
  observation: Observation;
  coalesce?: string;
  deliver_to_self?: boolean;
};

export type ShadowBrowserNodeCache = {
  kind: "woo.browser_cache.shadow.v1";
  object_pages: Map<string, SerializedObject>;
  object_page_refs: Map<ObjRef, string>;
  projections: Map<ObjRef, WooValue>;
  transcript_tail: EffectTranscript[];
  pending_turns: Map<string, ShadowBrowserPendingTurn>;
  applied_frames: ShadowCommitAccepted[];
  conflicts: ShadowCommitConflict[];
  transfers: ShadowStateTransfer[];
  live_events: ShadowLiveEvent[];
};

export type ShadowBrowserPendingTurn = {
  id: string;
  call: ShadowTurnCall;
  key: ShadowTurnKey;
  planned_transcript: EffectTranscript;
};

export type ShadowBrowserRelayShim = {
  kind: "woo.browser_relay.shadow.v1";
  node: string;
  commit_scope: ShadowCommitScope;
  executors: ShadowExecutionNode[];
  subscriptions: Map<ObjRef, Set<string>>;
  browsers: Map<string, ShadowBrowserNode>;
  live_events: ShadowLiveEvent[];
};

export type ShadowBrowserNode = {
  kind: "woo.browser_node.shadow.v1";
  node: string;
  scope: ObjRef;
  actor: ObjRef;
  session: string | null;
  execution_node: ShadowExecutionNode;
  relay: ShadowBrowserRelayShim;
  cache: ShadowBrowserNodeCache;
  next_turn: number;
  next_live: number;
};

export type ShadowBrowserOpenScopeResult = {
  projection: WooValue;
  preseeded_objects: number;
};

export type ShadowBrowserTurnInput = {
  id?: string;
  route?: ShadowTurnCall["route"];
  scope?: ObjRef;
  target: ObjRef;
  verb: string;
  args?: WooValue[];
  commit_policy?: ShadowTurnExecRequest["commit_policy"];
};

export type ShadowBrowserTurnResult = {
  id: string;
  call: ShadowTurnCall;
  key: ShadowTurnKey;
  planned_transcript: EffectTranscript;
  network: ShadowInProcessNetworkResult;
  result: ShadowTurnExecutionResult;
};

export function createShadowBrowserRelayShim(input: {
  node: string;
  scope: ObjRef;
  serialized: SerializedWorld;
  executors?: ShadowExecutionNode[];
}): ShadowBrowserRelayShim {
  return {
    kind: "woo.browser_relay.shadow.v1",
    node: input.node,
    commit_scope: createShadowCommitScope({
      node: input.node,
      scope: input.scope,
      serialized: input.serialized
    }),
    executors: input.executors ?? [],
    subscriptions: new Map(),
    browsers: new Map(),
    live_events: []
  };
}

export function createShadowBrowserNode(input: {
  node: string;
  scope: ObjRef;
  actor: ObjRef;
  session?: string | null;
  relay: ShadowBrowserRelayShim;
  cached_objects?: SerializedObject[];
}): ShadowBrowserNode {
  const executionNode = createShadowExecutionNode({
    node: input.node,
    scope: input.scope,
    cached_objects: input.cached_objects
  });
  const cache = createShadowBrowserNodeCache();
  cacheObjectPages(cache, input.cached_objects ?? []);
  return {
    kind: "woo.browser_node.shadow.v1",
    node: input.node,
    scope: input.scope,
    actor: input.actor,
    session: input.session ?? null,
    execution_node: executionNode,
    relay: input.relay,
    cache,
    next_turn: 1,
    next_live: 1
  };
}

export function createShadowBrowserNodeCache(): ShadowBrowserNodeCache {
  return {
    kind: "woo.browser_cache.shadow.v1",
    object_pages: new Map(),
    object_page_refs: new Map(),
    projections: new Map(),
    transcript_tail: [],
    pending_turns: new Map(),
    applied_frames: [],
    conflicts: [],
    transfers: [],
    live_events: []
  };
}

export function shadowBrowserCatalogObjects(serialized: SerializedWorld): SerializedObject[] {
  return serialized.objects
    .filter((obj) => obj.id.startsWith("$"))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function openShadowBrowserScope(
  browser: ShadowBrowserNode,
  options: { preseed_catalog_pages?: boolean } = {}
): Promise<ShadowBrowserOpenScopeResult> {
  const serialized = browser.relay.commit_scope.serialized;
  const preseed = options.preseed_catalog_pages === true ? shadowBrowserCatalogObjects(serialized) : [];
  if (preseed.length > 0) {
    installShadowCachedObjectRecords(browser.execution_node, preseed);
    cacheObjectPages(browser.cache, preseed);
  }
  const projection = shadowScopeProjection(serialized, browser.scope);
  browser.cache.projections.set(browser.scope, projection);
  subscribeShadowBrowserNode(browser, browser.scope);
  return {
    projection,
    preseeded_objects: preseed.length
  };
}

export function subscribeShadowBrowserNode(browser: ShadowBrowserNode, scope: ObjRef = browser.scope): void {
  browser.relay.browsers.set(browser.node, browser);
  let subscribers = browser.relay.subscriptions.get(scope);
  if (!subscribers) {
    subscribers = new Set();
    browser.relay.subscriptions.set(scope, subscribers);
  }
  subscribers.add(browser.node);
}

export function unsubscribeShadowBrowserNode(browser: ShadowBrowserNode, scope: ObjRef = browser.scope): void {
  browser.relay.subscriptions.get(scope)?.delete(browser.node);
}

export function emitShadowBrowserLiveEvent(browser: ShadowBrowserNode, input: ShadowBrowserLiveInput): ShadowLiveEvent {
  const event: ShadowLiveEvent = {
    kind: "woo.live.event.shadow.v1",
    id: input.id ?? `${browser.node}:live:${browser.next_live++}`,
    source: input.source,
    actor: input.actor ?? browser.actor,
    scope: input.scope ?? browser.scope,
    audience: input.audience,
    observation: input.observation,
    coalesce: input.coalesce
  };
  publishShadowBrowserLiveEvent(browser.relay, event, {
    except: input.deliver_to_self === true ? null : browser.node
  });
  return event;
}

export function publishShadowBrowserLiveEvent(
  relay: ShadowBrowserRelayShim,
  event: ShadowLiveEvent,
  options: { except?: string | null } = {}
): void {
  relay.live_events.push(structuredClone(event) as ShadowLiveEvent);
  for (const browser of relay.browsers.values()) {
    if (options.except && browser.node === options.except) continue;
    if (!shadowLiveEventMatchesBrowser(relay, browser, event)) continue;
    receiveShadowBrowserLiveEvent(browser, event);
  }
}

function receiveShadowBrowserLiveEvent(browser: ShadowBrowserNode, event: ShadowLiveEvent): void {
  const cloned = structuredClone(event) as ShadowLiveEvent;
  if (event.coalesce) {
    const index = browser.cache.live_events.findIndex((item) => item.coalesce === event.coalesce);
    if (index >= 0) {
      browser.cache.live_events[index] = cloned;
      return;
    }
  }
  browser.cache.live_events.push(cloned);
}

function shadowLiveEventMatchesBrowser(
  relay: ShadowBrowserRelayShim,
  browser: ShadowBrowserNode,
  event: ShadowLiveEvent
): boolean {
  const audience = event.audience;
  if (audience?.sessions?.includes(browser.session ?? "")) return true;
  if (audience?.actors?.includes(browser.actor)) return true;
  const scope = audience?.scope ?? event.scope;
  return typeof scope === "string" && relay.subscriptions.get(scope)?.has(browser.node) === true;
}

export async function executeShadowBrowserTurn(
  browser: ShadowBrowserNode,
  input: ShadowBrowserTurnInput
): Promise<ShadowBrowserTurnResult> {
  const id = input.id ?? `${browser.node}:turn:${browser.next_turn++}`;
  const call: ShadowTurnCall = {
    kind: "woo.turn_call.shadow.v1",
    id,
    route: input.route ?? "sequenced",
    scope: input.scope ?? browser.scope,
    session: browser.session,
    actor: browser.actor,
    target: input.target,
    verb: input.verb,
    args: input.args ?? []
  };
  const planned = await runShadowTurnCall(browser.relay.commit_scope.serialized, call);
  const key = shadowTurnKeyFromTranscript(planned.transcript);
  const pending: ShadowBrowserPendingTurn = {
    id,
    call,
    key,
    planned_transcript: planned.transcript
  };
  browser.cache.pending_turns.set(id, pending);

  const request: ShadowTurnExecRequest = {
    kind: "woo.turn_exec_request.shadow.v1",
    id,
    call,
    key,
    expected: browser.relay.commit_scope.head,
    auth: {
      mode: "shadow_local",
      actor: browser.actor,
      session: browser.session
    },
    commit_policy: input.commit_policy ?? "execute_and_commit"
  };

  const network = await executeShadowTurnCallAcrossInProcessNetwork({
    request,
    nodes: [browser.execution_node, ...browser.relay.executors],
    // Browser nodes do not broadcast broad capability in production. This ad is
    // the relay's local optimistic route back to the actor node; exact inventory
    // is still checked before VM execution.
    ads: [buildShadowTurnExecAd({ node: browser.execution_node.node, scope: key.scope, key, factor: 0.1 })],
    anchor: {
      node: browser.relay.node,
      serialized: browser.relay.commit_scope.serialized
    },
    commitScope: browser.relay.commit_scope
  });

  for (const transfer of network.transfers) applyShadowBrowserTransfer(browser, transfer);
  if (network.result.ok) {
    browser.cache.pending_turns.delete(id);
    browser.cache.transcript_tail.push(network.result.transcript);
    if (network.result.commit) applyShadowBrowserAcceptedFrame(browser, network.result.commit);
  } else if (network.result.reason === "commit_rejected") {
    browser.cache.pending_turns.delete(id);
    if (network.result.commit) applyShadowBrowserConflict(browser, network.result.commit);
  }

  return {
    id,
    call,
    key,
    planned_transcript: planned.transcript,
    network,
    result: network.result
  };
}

export function applyShadowBrowserAcceptedFrame(browser: ShadowBrowserNode, accepted: ShadowCommitAccepted): void {
  browser.cache.applied_frames.push(accepted);
  browser.cache.projections.set(browser.scope, shadowScopeProjection(accepted.serialized_after, browser.scope));
}

export function applyShadowBrowserConflict(browser: ShadowBrowserNode, conflict: ShadowCommitConflict): void {
  browser.cache.conflicts.push(conflict);
}

export function applyShadowBrowserTransfer(browser: ShadowBrowserNode, transfer: ShadowStateTransfer): void {
  browser.cache.transfers.push(transfer);
  if (transfer.mode === "closure") {
    cacheObjectPages(browser.cache, transfer.serialized.objects);
    return;
  }
  cacheObjectPages(browser.cache, transfer.objects);
}

function cacheObjectPages(cache: ShadowBrowserNodeCache, objects: SerializedObject[]): void {
  for (const obj of objects) {
    const hash = shadowObjectRecordHash(obj);
    cache.object_pages.set(hash, structuredClone(obj) as SerializedObject);
    cache.object_page_refs.set(obj.id, hash);
  }
}

function shadowScopeProjection(serialized: SerializedWorld, scope: ObjRef): WooValue {
  const scopeObj = serialized.objects.find((obj) => obj.id === scope);
  return {
    kind: "woo.scope_projection.shadow.v1",
    scope,
    title: scopeObj?.name ?? scope,
    object_count: serialized.objects.length,
    contents: scopeObj?.contents ?? [],
    seq: serialized.logs.find(([space]) => space === scope)?.[1].reduce((max, entry) => Math.max(max, entry.seq), 0) ?? 0
  };
}
