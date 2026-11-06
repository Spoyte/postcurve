// XMSS tree of WOTS one-time keys, the envelope codec, and verification.
// See spec/signature.md.

import {
  bytesToHex,
  decodeAbiParameters,
  encodeAbiParameters,
  hexToBytes,
  parseAbiParameters,
  type Hex,
} from "viem";
import { derivePubSeed, leafHash, nodeHash } from "./hash";
import { ENVELOPE_BYTES, LEAF_COUNT, LEN, TREE_HEIGHT } from "./params";
import { wotsPk, wotsPkFromSig, wotsSign } from "./wots";

/** What the bunker account stores for one approver. */
export type Identity = { root: Hex; pubSeed: Hex };

/** levels[0] = 256 leaf hashes, levels[TREE_HEIGHT] = [root]. */
export type Tree = { pubSeed: Uint8Array; levels: Uint8Array[][] };

const ENVELOPE_ABI = parseAbiParameters("uint256, bytes32[67], bytes32[8]");

export function buildTree(seed: Uint8Array): Tree {
  const pubSeed = derivePubSeed(seed);
  const levels: Uint8Array[][] = [
    Array.from({ length: LEAF_COUNT }, (_, i) => leafHash(pubSeed, i, wotsPk(seed, pubSeed, i))),
  ];
  for (let k = 1; k <= TREE_HEIGHT; k++) {
    const below = levels[k - 1]!;
    levels.push(
      Array.from({ length: below.length / 2 }, (_, i) =>
        nodeHash(pubSeed, k, i, below[2 * i]!, below[2 * i + 1]!),
      ),
    );
  }
  return { pubSeed, levels };
}

export function identityOf(tree: Tree): Identity {
  return { root: bytesToHex(tree.levels[TREE_HEIGHT]![0]!), pubSeed: bytesToHex(tree.pubSeed) };
}

/** Siblings of the leaf's ancestors, from the leaf level (k = 0) up to just below the root. */
export function authPath(tree: Tree, leaf: number): Uint8Array[] {
  checkLeaf(leaf);
  const path: Uint8Array[] = [];
  let i = leaf;
  for (let k = 0; k < TREE_HEIGHT; k++) {
    path.push(tree.levels[k]![i ^ 1]!);
    i >>= 1;
  }
  return path;
}

export function encodeEnvelope(leaf: number, sig: Uint8Array[], auth: Uint8Array[]): Hex {
  checkLeaf(leaf);
  if (sig.length !== LEN || auth.length !== TREE_HEIGHT) {
    throw new RangeError("signature must be 67 words and auth path 8 words");
  }
  return encodeAbiParameters(ENVELOPE_ABI, [
    BigInt(leaf),
    sig.map((w) => bytesToHex(w)) as never,
    auth.map((w) => bytesToHex(w)) as never,
  ]);
}

/** Null unless the envelope is exactly 2432 bytes of well-formed hex with leaf < 256. */
export function decodeEnvelope(
  envelope: Hex,
): { leaf: number; sig: Uint8Array[]; auth: Uint8Array[] } | null {
  try {
    if (hexToBytes(envelope).length !== ENVELOPE_BYTES) return null;
    const [leaf, sig, auth] = decodeAbiParameters(ENVELOPE_ABI, envelope);
    if (leaf >= BigInt(LEAF_COUNT)) return null;
    return {
      leaf: Number(leaf),
      sig: sig.map((w) => hexToBytes(w)),
      auth: auth.map((w) => hexToBytes(w)),
    };
  } catch {
    return null;
  }
}

/**
 * Signs a digest with one leaf. Pure: it does not track used leaves, so callers must never
 * sign two different digests with the same leaf. Use `Approver`, which enforces that.
 */
export function signEnvelope(seed: Uint8Array, tree: Tree, leaf: number, digest: Hex): Hex {
  const sig = wotsSign(seed, tree.pubSeed, leaf, hexToBytes(digest));
  return encodeEnvelope(leaf, sig, authPath(tree, leaf));
}

/** Returns the leaf index if the envelope is a valid signature of `digest`, else null. */
export function verifyEnvelope(id: Identity, digest: Hex, envelope: Hex): number | null {
  try {
    const parts = decodeEnvelope(envelope);
    if (!parts) return null;
    const pubSeed = hexToBytes(id.pubSeed);
    const pk = wotsPkFromSig(pubSeed, parts.leaf, hexToBytes(digest), parts.sig);
    let node = leafHash(pubSeed, parts.leaf, pk);
    let i = parts.leaf;
    for (let k = 0; k < TREE_HEIGHT; k++) {
      const sibling = parts.auth[k]!;
      node =
        i % 2 === 0
          ? nodeHash(pubSeed, k + 1, i >> 1, node, sibling)
          : nodeHash(pubSeed, k + 1, i >> 1, sibling, node);
      i >>= 1;
    }
    return bytesToHex(node) === id.root.toLowerCase() ? parts.leaf : null;
  } catch {
    return null;
  }
}

function checkLeaf(leaf: number) {
  if (!Number.isInteger(leaf) || leaf < 0 || leaf >= LEAF_COUNT) {
    throw new RangeError(`leaf ${leaf} out of range 0..${LEAF_COUNT - 1}`);
  }
}
