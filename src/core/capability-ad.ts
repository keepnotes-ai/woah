import { hashSource } from "./source-hash";
import type { ObjRef } from "./types";
import type { ShadowTurnKey } from "./turn-key";

export type ShadowBloomFilter = {
  m: number;
  k: number;
  bits_hex: string;
};

export type ShadowCapabilityAd = {
  kind: "woo.exec_capability_ad.shadow.v1";
  node: string;
  scope: ObjRef;
  epoch: string;
  covers: ShadowBloomFilter;
  accepts: ShadowBloomFilter;
  effects: number;
  factor: number;
};

export function buildShadowCapabilityAd(input: {
  node: string;
  scope: ObjRef;
  epoch?: string;
  atom_hashes: string[];
  accepts_atom_hashes?: string[];
  effects?: number;
  factor?: number;
  m?: number;
  k?: number;
}): ShadowCapabilityAd {
  const m = input.m ?? 512;
  const k = input.k ?? 4;
  const covers = buildBloom(input.atom_hashes, m, k);
  const accepts = buildBloom(input.accepts_atom_hashes ?? input.atom_hashes, m, k);
  return {
    kind: "woo.exec_capability_ad.shadow.v1",
    node: input.node,
    scope: input.scope,
    epoch: input.epoch ?? "shadow",
    covers,
    accepts,
    effects: input.effects ?? 0,
    factor: input.factor ?? 1
  };
}

export function capabilityAdProbablyCoversTurn(ad: ShadowCapabilityAd, key: ShadowTurnKey): boolean {
  if (ad.scope !== key.scope) return false;
  return bloomContainsAll(ad.covers, key.atom_hashes) && bloomContainsAll(ad.accepts, key.accept_atom_hashes);
}

export function rankCapabilityAdsForTurn(ads: ShadowCapabilityAd[], key: ShadowTurnKey): ShadowCapabilityAd[] {
  return ads
    .filter((ad) => capabilityAdProbablyCoversTurn(ad, key))
    .sort((a, b) => a.factor - b.factor || a.node.localeCompare(b.node));
}

function buildBloom(atomHashes: string[], m: number, k: number): ShadowBloomFilter {
  const bytes = new Uint8Array(Math.ceil(m / 8));
  for (const atomHash of atomHashes) {
    for (const index of bloomIndexes(atomHash, m, k)) setBit(bytes, index);
  }
  return { m, k, bits_hex: bytesToHex(bytes) };
}

function bloomContainsAll(filter: ShadowBloomFilter, atomHashes: string[]): boolean {
  const bytes = hexToBytes(filter.bits_hex);
  return atomHashes.every((atomHash) =>
    bloomIndexes(atomHash, filter.m, filter.k).every((index) => getBit(bytes, index))
  );
}

function bloomIndexes(atomHash: string, m: number, k: number): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < k; i++) {
    const digest = hashSource(`${i}:${atomHash}`);
    indexes.push(Number.parseInt(digest.slice(0, 12), 16) % m);
  }
  return indexes;
}

function setBit(bytes: Uint8Array, index: number): void {
  bytes[Math.floor(index / 8)] |= 1 << (index % 8);
}

function getBit(bytes: Uint8Array, index: number): boolean {
  return (bytes[Math.floor(index / 8)] & (1 << (index % 8))) !== 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
