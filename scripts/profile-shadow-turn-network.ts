import { createWorld } from "../src/core/bootstrap";
import { estimateShadowStateTransferBytes, profileShadowTurnAcrossNetworkShapes } from "../src/core/shadow-gossip-profile";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { createShadowExecutionNode } from "../src/core/shadow-turn-exec";
import { buildShadowTurnExecAd, executeShadowTurnCallAcrossInProcessNetwork } from "../src/core/shadow-turn-network";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";

const world = createWorld();
const session = world.auth("guest:shadow-profile-cli");
const actor = session.actor;

await world.directCall("shadow-profile-cli-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

const serializedBefore = world.exportWorld();
const call: ShadowTurnCall = {
  kind: "woo.turn_call.shadow.v1",
  id: "shadow-profile-cli-set-control",
  route: "sequenced",
  scope: "the_dubspace",
  session: session.id,
  actor,
  target: "the_dubspace",
  verb: "set_control",
  args: ["delay_1", "wet", 0.59]
};

const planned = await runShadowTurnCall(serializedBefore, call);
const key = shadowTurnKeyFromTranscript(planned.transcript);
const profiles = await profileShadowTurnAcrossNetworkShapes({ serializedBefore, call, key });

console.log("Shadow turn network profile");
console.log(`turn=${planned.transcript.id ?? "(none)"} transcript=${planned.transcript.hash} atoms=${key.atom_hashes.length}`);
console.table(profiles.map((profile) => ({
  shape: profile.shape,
  accepted: profile.accepted,
  attempts: profile.attempts,
  latency_ms: profile.total_latency_ms,
  transfer_kib: Math.round(profile.transfer_bytes / 102.4) / 10,
  steps: profile.steps.map((step) => step.kind).join(" -> ")
})));

const actorNode = createShadowExecutionNode({ node: "actor", scope: key.scope });
const first = await executeShadowTurnCallAcrossInProcessNetwork({
  request: { kind: "woo.turn_exec_request.shadow.v1", call, key },
  nodes: [actorNode],
  ads: [buildShadowTurnExecAd({ node: "actor", scope: key.scope, key, factor: 0.1 })],
  anchor: { node: "anchor", serialized: serializedBefore }
});
if (!first.result.ok) throw new Error(`first warmup turn failed: ${first.result.reason}`);

const secondSerializedBefore = first.result.serializedAfter;
const secondCall: ShadowTurnCall = {
  ...call,
  id: "shadow-profile-cli-set-feedback",
  args: ["delay_1", "feedback", 0.41]
};
const secondPlanned = await runShadowTurnCall(secondSerializedBefore, secondCall);
const secondKey = shadowTurnKeyFromTranscript(secondPlanned.transcript);
const second = await executeShadowTurnCallAcrossInProcessNetwork({
  request: { kind: "woo.turn_exec_request.shadow.v1", call: secondCall, key: secondKey },
  nodes: [actorNode],
  ads: [buildShadowTurnExecAd({ node: "actor", scope: secondKey.scope, key: secondKey, factor: 0.1 })],
  anchor: { node: "anchor", serialized: secondSerializedBefore }
});
if (!second.result.ok) throw new Error(`second warmup turn failed: ${second.result.reason}`);

const catalogCachedNode = createShadowExecutionNode({
  node: "catalog-cached-browser",
  scope: key.scope,
  cached_objects: serializedBefore.objects.filter((obj) => obj.id.startsWith("$"))
});
const catalogCachedFirst = await executeShadowTurnCallAcrossInProcessNetwork({
  request: { kind: "woo.turn_exec_request.shadow.v1", call, key },
  nodes: [catalogCachedNode],
  ads: [buildShadowTurnExecAd({ node: "catalog-cached-browser", scope: key.scope, key, factor: 0.1 })],
  anchor: { node: "anchor", serialized: serializedBefore }
});
if (!catalogCachedFirst.result.ok) throw new Error(`catalog-cached first turn failed: ${catalogCachedFirst.result.reason}`);

console.log("\nShadow transfer warmup");
console.table([
  {
    turn: "first",
    missing: !first.first.ok && first.first.reason === "missing_state" ? first.first.missing_atoms.length : 0,
    inline_objects: first.transfer?.mode === "object_records" ? first.transfer.objects.length : null,
    page_refs: first.transfer?.mode === "object_records" ? first.transfer.object_pages.length : null,
    transfer_kib: first.transfer ? Math.round(estimateShadowStateTransferBytes(first.transfer) / 102.4) / 10 : 0
  },
  {
    turn: "first_catalog_cache",
    missing: !catalogCachedFirst.first.ok && catalogCachedFirst.first.reason === "missing_state" ? catalogCachedFirst.first.missing_atoms.length : 0,
    inline_objects: catalogCachedFirst.transfer?.mode === "object_records" ? catalogCachedFirst.transfer.objects.length : null,
    page_refs: catalogCachedFirst.transfer?.mode === "object_records" ? catalogCachedFirst.transfer.object_pages.length : null,
    transfer_kib: catalogCachedFirst.transfer ? Math.round(estimateShadowStateTransferBytes(catalogCachedFirst.transfer) / 102.4) / 10 : 0
  },
  {
    turn: "second",
    missing: !second.first.ok && second.first.reason === "missing_state" ? second.first.missing_atoms.length : 0,
    inline_objects: second.transfer?.mode === "object_records" ? second.transfer.objects.length : null,
    page_refs: second.transfer?.mode === "object_records" ? second.transfer.object_pages.length : null,
    transfer_kib: second.transfer ? Math.round(estimateShadowStateTransferBytes(second.transfer) / 102.4) / 10 : 0
  }
]);
