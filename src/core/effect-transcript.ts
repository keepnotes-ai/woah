import { createWorldFromSerialized } from "./bootstrap";
import type { SerializedWorld } from "./repository";
import { hashSource } from "./source-hash";
import type { ErrorValue, ObjRef, Observation, WooValue } from "./types";
import type { RecordedTurn, TurnRecorderEvent, TurnStart } from "./turn-recorder";

export type TranscriptCell =
  | { kind: "prop"; object: ObjRef; name: string }
  | { kind: "location"; object: ObjRef }
  | { kind: "lifecycle"; object: ObjRef };

export type TranscriptRead = {
  cell: TranscriptCell;
  version?: string;
  value: WooValue;
};

export type TranscriptWrite = {
  cell: TranscriptCell;
  prior?: string;
  next?: string;
  value: WooValue;
  op: "set" | "create" | "move";
};

export type TranscriptCreate = {
  object: ObjRef;
  parent: ObjRef | null;
  owner: ObjRef;
  anchor: ObjRef | null;
  location: ObjRef | null;
};

export type TranscriptMove = {
  object: ObjRef;
  from: ObjRef | null;
  to: ObjRef;
};

export type EffectTranscript = {
  kind: "woo.effect_transcript.shadow.v1";
  id?: string;
  route: TurnStart["route"];
  scope: ObjRef;
  seq: number;
  session?: string | null;
  call: Pick<TurnStart, "actor" | "target" | "verb" | "args">;
  reads: TranscriptRead[];
  writes: TranscriptWrite[];
  creates: TranscriptCreate[];
  moves: TranscriptMove[];
  observations: Observation[];
  logicalInputs: Array<{ name: string; value: WooValue }>;
  result?: WooValue;
  error?: ErrorValue;
  complete: boolean;
  incompleteReasons: string[];
  hash: string;
};

export type TranscriptValidation = {
  ok: boolean;
  errors: string[];
};

export function effectTranscriptFromRecordedTurn(turn: RecordedTurn): EffectTranscript {
  const reads: TranscriptRead[] = [];
  const writes: TranscriptWrite[] = [];
  const creates: TranscriptCreate[] = [];
  const moves: TranscriptMove[] = [];
  const observations: Observation[] = [];
  const logicalInputs: Array<{ name: string; value: WooValue }> = [];
  const incompleteReasons = new Set<string>();
  let result: WooValue | undefined;
  let error: ErrorValue | undefined;

  for (const event of turn.events) {
    switch (event.kind) {
      case "prop_read":
        reads.push({
          cell: { kind: "prop", object: event.object, name: event.name },
          version: versionString(event.version),
          value: event.value
        });
        break;
      case "prop_write":
        writes.push({
          cell: { kind: "prop", object: event.object, name: event.name },
          prior: versionString(event.beforeVersion),
          next: versionString(event.afterVersion),
          value: event.after,
          op: "set"
        });
        break;
      case "object_create":
        creates.push({
          object: event.object,
          parent: event.parent,
          owner: event.owner,
          anchor: event.anchor,
          location: event.location
        });
        writes.push({
          cell: { kind: "lifecycle", object: event.object },
          value: "created",
          op: "create"
        });
        break;
      case "object_move":
        moves.push({ object: event.object, from: event.from, to: event.to });
        writes.push({
          cell: { kind: "location", object: event.object },
          value: event.to,
          op: "move"
        });
        break;
      case "observe":
        observations.push(event.observation);
        break;
      case "logical_input":
        logicalInputs.push({ name: event.name, value: event.value });
        break;
      case "dispatch":
        if (event.implementation === "native") incompleteReasons.add(`native:${event.target}:${event.verb}`);
        break;
      case "untracked_effect":
        incompleteReasons.add(event.name);
        break;
      case "turn_finish":
        if (event.ok) result = event.result;
        else error = event.error;
        break;
      case "turn_start":
        break;
    }
  }

  const withoutHash = {
    kind: "woo.effect_transcript.shadow.v1" as const,
    id: turn.start.id,
    route: turn.start.route,
    scope: turn.start.scope,
    seq: turn.start.seq,
    session: turn.start.session,
    call: {
      actor: turn.start.actor,
      target: turn.start.target,
      verb: turn.start.verb,
      args: turn.start.args
    },
    reads,
    writes,
    creates,
    moves,
    observations,
    logicalInputs,
    result,
    error,
    complete: incompleteReasons.size === 0,
    incompleteReasons: Array.from(incompleteReasons).sort()
  };

  return {
    ...withoutHash,
    hash: hashSource(stableJson(withoutHash as unknown as WooValue))
  };
}

export function validateTranscriptAgainstSerializedWorld(serializedBefore: SerializedWorld, transcript: EffectTranscript): TranscriptValidation {
  const world = createWorldFromSerialized(serializedBefore, { persist: false });
  const errors: string[] = [];

  for (const read of transcript.reads) {
    if (read.cell.kind !== "prop") continue;
    try {
      const actual = world.getProp(read.cell.object, read.cell.name);
      const actualVersion = propVersion(serializedBefore, read.cell.object, read.cell.name);
      const readMatchesOwnWrite = transcript.writes.some((write) =>
        sameCell(write.cell, read.cell) &&
        write.next === read.version &&
        stableJson(write.value) === stableJson(read.value)
      );
      if (!readMatchesOwnWrite && read.version !== versionString(actualVersion)) {
        errors.push(`read version mismatch ${read.cell.object}.${read.cell.name}: transcript=${read.version ?? "none"} actual=${versionString(actualVersion) ?? "none"}`);
      }
      if (!readMatchesOwnWrite && stableJson(actual) !== stableJson(read.value)) {
        errors.push(`read value mismatch ${read.cell.object}.${read.cell.name}`);
      }
    } catch (err) {
      errors.push(`read unavailable ${read.cell.object}.${read.cell.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const write of transcript.writes) {
    if (write.cell.kind !== "prop") continue;
    const actualVersion = propVersion(serializedBefore, write.cell.object, write.cell.name);
    if (write.prior !== versionString(actualVersion)) {
      errors.push(`write prior mismatch ${write.cell.object}.${write.cell.name}: transcript=${write.prior ?? "none"} actual=${versionString(actualVersion) ?? "none"}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function propVersion(serialized: SerializedWorld, object: ObjRef, name: string): number | undefined {
  if (name === "owner") return undefined;
  const obj = serialized.objects.find((item) => item.id === object);
  if (!obj) return undefined;
  return obj.propertyVersions.find(([prop]) => prop === name)?.[1] ?? 0;
}

function sameCell(a: TranscriptCell, b: TranscriptCell): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "prop" && b.kind === "prop") return a.object === b.object && a.name === b.name;
  return a.object === b.object;
}

function versionString(version: number | undefined): string | undefined {
  return version === undefined ? undefined : String(version);
}

function stableJson(value: WooValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}
