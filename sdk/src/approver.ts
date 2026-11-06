// A stateful approver that never signs two digests with the same one-time key.

import { hexToBytes, type Hex } from "viem";
import { LEAF_COUNT } from "./params";
import { buildTree, identityOf, signEnvelope, type Identity, type Tree } from "./xmss";

export class TreeExhaustedError extends Error {
  constructor() {
    super(`all ${LEAF_COUNT} one-time keys are used; register a new approver identity`);
    this.name = "TreeExhaustedError";
  }
}

export class Approver {
  readonly identity: Identity;
  private readonly used: Set<number>;

  private constructor(
    private readonly seed: Uint8Array,
    private readonly tree: Tree,
    used: Iterable<number>,
  ) {
    this.identity = identityOf(tree);
    this.used = new Set();
    for (const leaf of used) {
      if (!Number.isInteger(leaf) || leaf < 0 || leaf >= LEAF_COUNT) {
        throw new RangeError(`used leaf ${leaf} out of range 0..${LEAF_COUNT - 1}`);
      }
      this.used.add(leaf);
    }
  }

  /** `usedLeaves` is the list the caller persisted from a previous session. */
  static fromSeed(seed: Uint8Array, usedLeaves: Iterable<number> = []): Approver {
    return new Approver(seed, buildTree(seed), usedLeaves);
  }

  /**
   * Signs with the lowest unused leaf. The leaf is recorded as used before the signature is
   * computed, so a failure part-way can never lead to the same leaf signing something else.
   * Callers must persist `usedLeaves()` before sending the envelope anywhere.
   */
  approve(digest: Hex): { leaf: number; envelope: Hex } {
    if (hexToBytes(digest).length !== 32) throw new RangeError("digest must be 32 bytes");
    let leaf = 0;
    while (leaf < LEAF_COUNT && this.used.has(leaf)) leaf++;
    if (leaf === LEAF_COUNT) throw new TreeExhaustedError();
    this.used.add(leaf);
    return { leaf, envelope: signEnvelope(this.seed, this.tree, leaf, digest) };
  }

  usedLeaves(): number[] {
    return [...this.used].sort((a, b) => a - b);
  }

  remaining(): number {
    return LEAF_COUNT - this.used.size;
  }
}
