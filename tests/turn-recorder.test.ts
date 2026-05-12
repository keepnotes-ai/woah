import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import { effectTranscriptFromRecordedTurn, validateTranscriptAgainstSerializedWorld } from "../src/core/effect-transcript";
import { comparableTurnEvents, replayRecordedTurn } from "../src/core/turn-replay";
import { InMemoryTurnRecorder } from "../src/core/turn-recorder";
import { message } from "./core-support";

describe("turn recorder", () => {
  it("records a direct VM turn's central reads, writes, observations, and logical inputs", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-recorder");
    const actor = session.actor;
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    world.createObject({ id: "rec_box", name: "Recorder Box", parent: "$thing", owner: actor });
    world.defineProperty("rec_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    const installed = installVerb(
      world,
      "rec_box",
      "bump",
      `verb :bump() rxd {
        let before = this.counter;
        this.counter = before + 1;
        observe({ type: "bumped", source: this, actor: actor, value: this.counter, ts: now() });
        return this.counter;
      }`,
      null
    );
    expect(installed.ok).toBe(true);

    const result = await world.directCall("rec-bump", actor, "rec_box", "bump", []);

    expect(result.op).toBe("result");
    if (result.op === "result") expect(result.result).toBe(1);
    expect(recorder.turns).toHaveLength(1);
    const events = recorder.turns[0].events;
    expect(events).toContainEqual(expect.objectContaining({ kind: "turn_start" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "dispatch", target: "rec_box", verb: "bump", implementation: "bytecode" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "prop_read", object: "rec_box", name: "counter", value: 0, version: 1 }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "prop_write", object: "rec_box", name: "counter", after: 1, changed: true, beforeVersion: 1, afterVersion: 2 }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "logical_input", name: "now" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "observe", observation: expect.objectContaining({ type: "bumped", value: 1 }) }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "turn_finish", ok: true, result: 1 }));

    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript).toMatchObject({
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: "#-1",
      complete: true,
      call: { actor, target: "rec_box", verb: "bump", args: [] },
      result: 1
    });
    expect(transcript.reads).toContainEqual(expect.objectContaining({ cell: { kind: "prop", object: "rec_box", name: "counter" }, version: "1", value: 0 }));
    expect(transcript.writes).toContainEqual(expect.objectContaining({ cell: { kind: "prop", object: "rec_box", name: "counter" }, prior: "1", next: "2", value: 1, op: "set" }));
    expect(transcript.observations).toContainEqual(expect.objectContaining({ type: "bumped", value: 1 }));
    expect(transcript.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records sequenced turns at the applied-call boundary", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-recorder-seq");
    const actor = session.actor;
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const entered = await world.directCall("seq-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });
    expect(entered.op).toBe("result");
    recorder.turns.length = 0;

    const frame = await world.call(
      "seq-control",
      session.id,
      "the_dubspace",
      message(actor, "the_dubspace", "set_control", ["delay_1", "feedback", 0.37])
    );

    expect(frame.op).toBe("applied");
    expect(recorder.turns).toHaveLength(1);
    const turn = recorder.turns[0];
    expect(turn.start).toMatchObject({ id: "seq-control", route: "sequenced", scope: "the_dubspace", actor, target: "the_dubspace", verb: "set_control" });
    expect(turn.events).toContainEqual(expect.objectContaining({ kind: "prop_write", object: "delay_1", name: "feedback", after: 0.37, changed: true }));
    expect(turn.events).toContainEqual(expect.objectContaining({ kind: "observe", observation: expect.objectContaining({ type: "control_changed", target: "delay_1", name: "feedback", value: 0.37 }) }));
  });

  it("can replay a recorded deterministic turn against a serialized pre-turn world", async () => {
    const world = createWorld();
    const session = world.auth("guest:turn-replay");
    const actor = session.actor;

    world.createObject({ id: "replay_box", name: "Replay Box", parent: "$thing", owner: actor });
    world.defineProperty("replay_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    const installed = installVerb(
      world,
      "replay_box",
      "bump",
      `verb :bump() rxd {
        let before = this.counter;
        this.counter = before + 1;
        observe({ type: "bumped", source: this, actor: actor, value: this.counter, ts: now() });
        return this.counter;
      }`,
      null
    );
    expect(installed.ok).toBe(true);

    const before = world.exportWorld();
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);
    const result = await world.directCall("replay-bump", actor, "replay_box", "bump", [], { sessionId: session.id });
    expect(result.op).toBe("result");

    const replay = await replayRecordedTurn(before, recorder.turns[0]);

    expect(replay.frame.op).toBe("result");
    expect(comparableTurnEvents(replay.recorded.events)).toEqual(comparableTurnEvents(recorder.turns[0].events));
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(effectTranscriptFromRecordedTurn(replay.recorded)).toEqual(transcript);
    expect(validateTranscriptAgainstSerializedWorld(before, transcript)).toEqual({ ok: true, errors: [] });
  });
});
