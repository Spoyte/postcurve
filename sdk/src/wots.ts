// WOTS one-time signatures (w = 16, 67 chains). See spec/signature.md.

import { chainStep, deriveSk } from "./hash";
import { CHAIN_MAX, LEN, LEN1, N } from "./params";

/** The 67 base-16 digits signed for a 32-byte digest: 64 nibbles (high first) + 3 checksum. */
export function digits(digest: Uint8Array): number[] {
  if (digest.length !== N) throw new RangeError(`digest is ${digest.length} bytes, expected ${N}`);
  const out: number[] = [];
  for (const byte of digest) out.push(byte >> 4, byte & 0x0f);
  let csum = 0;
  for (let i = 0; i < LEN1; i++) csum += CHAIN_MAX - out[i]!;
  out.push((csum >> 8) & 0x0f, (csum >> 4) & 0x0f, csum & 0x0f);
  return out;
}

function chain(
  x: Uint8Array,
  pubSeed: Uint8Array,
  leaf: number,
  j: number,
  start: number,
  steps: number,
): Uint8Array {
  for (let s = start; s < start + steps; s++) x = chainStep(pubSeed, leaf, j, s, x);
  return x;
}

export function wotsPk(seed: Uint8Array, pubSeed: Uint8Array, leaf: number): Uint8Array[] {
  return Array.from({ length: LEN }, (_, j) =>
    chain(deriveSk(seed, leaf, j), pubSeed, leaf, j, 0, CHAIN_MAX),
  );
}

export function wotsSign(
  seed: Uint8Array,
  pubSeed: Uint8Array,
  leaf: number,
  digest: Uint8Array,
): Uint8Array[] {
  const b = digits(digest);
  return b.map((bj, j) => chain(deriveSk(seed, leaf, j), pubSeed, leaf, j, 0, bj));
}

export function wotsPkFromSig(
  pubSeed: Uint8Array,
  leaf: number,
  digest: Uint8Array,
  sig: Uint8Array[],
): Uint8Array[] {
  if (sig.length !== LEN) throw new RangeError(`signature has ${sig.length} words, expected ${LEN}`);
  const b = digits(digest);
  return sig.map((sj, j) => chain(sj, pubSeed, leaf, j, b[j]!, CHAIN_MAX - b[j]!));
}
