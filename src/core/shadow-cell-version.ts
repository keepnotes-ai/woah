import type { SerializedObject } from "./repository";
import { hashSource } from "./source-hash";
import type { ObjRef, WooObject, WooValue } from "./types";

export type ShadowStructuralCellKind = "location" | "contents" | "lifecycle";

type VersionedObject =
  Pick<WooObject | SerializedObject, "id" | "name" | "parent" | "owner" | "location" | "anchor" | "flags"> & {
    contents: Iterable<ObjRef>;
  };

// Shadow transcripts must replay to the same hashes on another node. These
// versions are therefore derived from deterministic cell content, not from the
// runtime's wall-clock `modified` field.
export function shadowStructuralCellVersion(kind: ShadowStructuralCellKind, object: VersionedObject): string {
  switch (kind) {
    case "location":
      return shadowVersionHash({ cell: "location", object: object.id, location: object.location });
    case "contents":
      return shadowVersionHash({ cell: "contents", object: object.id, contents: Array.from(object.contents).sort() });
    case "lifecycle":
      return shadowVersionHash({
        cell: "lifecycle",
        object: object.id,
        name: object.name,
        parent: object.parent,
        owner: object.owner,
        anchor: object.anchor,
        flags: stableFlags(object.flags)
      });
  }
}

export function shadowOwnerCellVersion(object: ObjRef, owner: ObjRef): string {
  return shadowVersionHash({ cell: "owner", object, owner });
}

function shadowVersionHash(payload: Record<string, WooValue>): string {
  return hashSource(stableShadowJson({
    kind: "woo.shadow_cell_version.v1",
    ...payload
  }));
}

function stableFlags(flags: WooObject["flags"]): Record<string, WooValue> {
  const out: Record<string, WooValue> = {};
  for (const key of ["fertile", "programmer", "wizard"] as const) {
    if (flags[key] !== undefined) out[key] = flags[key] === true;
  }
  return out;
}

export function stableShadowJson(value: WooValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableShadowJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableShadowJson(value[key])}`)
    .join(",")}}`;
}
