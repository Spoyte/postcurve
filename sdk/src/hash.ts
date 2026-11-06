// Every keyed or tweaked hash of the format. Each input is a list of 32-byte words, laid out
// like Solidity abi.encode, then hashed with keccak256. See spec/signature.md.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { DOMAIN, LEN, N } from "./params";

/** 32-byte big-endian encoding of a non-negative integer below 2^256. */
export function u256(x: bigint | number): Uint8Array {
  let v = BigInt(x);
  if (v < 0n || v >= 1n << 256n) throw new RangeError(`u256 out of range: ${x}`);
  const out = new Uint8Array(N);
  for (let i = N - 1; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** keccak256 of the concatenated words. Throws unless every word is exactly 32 bytes. */
export function hashWords(words: Uint8Array[]): Uint8Array {
  const buf = new Uint8Array(words.length * N);
  words.forEach((w, i) => {
    if (w.length !== N) throw new RangeError(`word ${i} is ${w.length} bytes, expected ${N}`);
    buf.set(w, i * N);
  });
  return keccak_256(buf);
}

export function derivePubSeed(seed: Uint8Array): Uint8Array {
  return hashWords([u256(DOMAIN.PUBSEED), seed]);
}

export function deriveSk(seed: Uint8Array, leaf: number, chain: number): Uint8Array {
  return hashWords([u256(DOMAIN.SK), seed, u256((BigInt(leaf) << 8n) | BigInt(chain))]);
}

export function chainStep(
  pubSeed: Uint8Array,
  leaf: number,
  chain: number,
  step: number,
  x: Uint8Array,
): Uint8Array {
  const address = (BigInt(leaf) << 16n) | (BigInt(chain) << 8n) | BigInt(step);
  return hashWords([u256(DOMAIN.CHAIN), pubSeed, u256(address), x]);
}

export function leafHash(pubSeed: Uint8Array, leaf: number, pk: Uint8Array[]): Uint8Array {
  if (pk.length !== LEN) throw new RangeError(`public key has ${pk.length} words, expected ${LEN}`);
  return hashWords([u256(DOMAIN.LEAF), pubSeed, u256(leaf), ...pk]);
}

export function nodeHash(
  pubSeed: Uint8Array,
  level: number,
  index: number,
  left: Uint8Array,
  right: Uint8Array,
): Uint8Array {
  const address = (BigInt(level) << 32n) | BigInt(index);
  return hashWords([u256(DOMAIN.NODE), pubSeed, u256(address), left, right]);
}
