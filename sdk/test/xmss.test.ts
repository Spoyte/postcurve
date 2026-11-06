import { beforeAll, describe, expect, test } from "bun:test";
import { bytesToHex, hexToBytes, keccak256, toHex, type Hex } from "viem";
import { u256 } from "../src/hash";
import {
  buildTree,
  decodeEnvelope,
  identityOf,
  signEnvelope,
  verifyEnvelope,
  type Identity,
  type Tree,
} from "../src/xmss";

const seed = u256(1n);
const d: Hex = keccak256(toHex("approve this"));
let tree: Tree;
let id: Identity;
let valid: Hex; // envelope for leaf 9

const SIG_OFFSET = 32;
const AUTH_OFFSET = 32 + 67 * 32;

function mutate(env: Hex, f: (b: Uint8Array) => void): Hex {
  const b = hexToBytes(env);
  f(b);
  return bytesToHex(b);
}

beforeAll(() => {
  tree = buildTree(seed);
  id = identityOf(tree);
  valid = signEnvelope(seed, tree, 9, d);
});

describe("XMSS envelopes", () => {
  test.each([0, 1, 254, 255])("leaf %i verifies and returns its index", (leaf) => {
    expect(verifyEnvelope(id, d, signEnvelope(seed, tree, leaf, d))).toBe(leaf);
  });

  test("tree shape: 256 leaves, 9 levels, single root", () => {
    expect(tree.levels).toHaveLength(9);
    expect(tree.levels[0]).toHaveLength(256);
    expect(tree.levels[8]).toHaveLength(1);
    expect(id.root).toBe(bytesToHex(tree.levels[8]![0]!));
  });

  test("envelope is 2432 bytes and decodes to its parts", () => {
    expect(hexToBytes(valid)).toHaveLength(2432);
    const parts = decodeEnvelope(valid);
    expect(parts?.leaf).toBe(9);
    expect(parts?.sig).toHaveLength(67);
    expect(parts?.auth).toHaveLength(8);
  });

  test("wrong digest -> null", () => {
    expect(verifyEnvelope(id, keccak256(toHex("something else")), valid)).toBeNull();
  });

  test("wrong root -> null", () => {
    expect(verifyEnvelope({ ...id, root: keccak256(id.root) }, d, valid)).toBeNull();
  });

  test("wrong pubSeed -> null", () => {
    expect(verifyEnvelope({ ...id, pubSeed: keccak256(id.pubSeed) }, d, valid)).toBeNull();
  });

  test("one flipped byte in sig -> null", () => {
    const bad = mutate(valid, (b) => (b[SIG_OFFSET + 5]! ^= 0x01));
    expect(verifyEnvelope(id, d, bad)).toBeNull();
  });

  test("one flipped byte in auth path -> null", () => {
    const bad = mutate(valid, (b) => (b[AUTH_OFFSET + 3]! ^= 0x80));
    expect(verifyEnvelope(id, d, bad)).toBeNull();
  });

  test("leaf word set to another valid index -> null", () => {
    const bad = mutate(valid, (b) => b.set(u256(10n), 0));
    expect(verifyEnvelope(id, d, bad)).toBeNull();
  });

  test("leaf word 256 -> null", () => {
    const bad = mutate(valid, (b) => b.set(u256(256n), 0));
    expect(decodeEnvelope(bad)).toBeNull();
    expect(verifyEnvelope(id, d, bad)).toBeNull();
  });

  test("2431 and 2433 bytes -> null, no throw", () => {
    const short = bytesToHex(hexToBytes(valid).slice(0, 2431));
    const long = bytesToHex(new Uint8Array([...hexToBytes(valid), 0]));
    expect(verifyEnvelope(id, d, short)).toBeNull();
    expect(verifyEnvelope(id, d, long)).toBeNull();
  });

  test("garbage hex -> null, no throw", () => {
    expect(verifyEnvelope(id, d, "0x123" as Hex)).toBeNull();
    expect(verifyEnvelope(id, "0xzz" as Hex, valid)).toBeNull();
  });

  test("buildTree finishes in under 5 s", () => {
    const t0 = performance.now();
    buildTree(u256(2n));
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
