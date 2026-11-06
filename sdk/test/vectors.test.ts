import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { approvalDigest, verifyEnvelope } from "../src";
import { generateVectors, serializeVectors, VECTORS_PATH } from "../scripts/gen-vectors";

describe("shared test vectors", () => {
  const generated = generateVectors();

  test("committed file byte-equals a fresh generation", () => {
    expect(readFileSync(VECTORS_PATH, "utf8")).toBe(serializeVectors(generated));
  });

  test("holds the three named vectors", () => {
    expect(generated.vectors.map((v) => v.name)).toEqual([
      "A-leaf0",
      "A-leaf255",
      "B-leaf7-approval",
    ]);
  });

  test.each(generateVectors().vectors)("$name verifies at its own leaf", (v) => {
    expect(verifyEnvelope({ root: v.root, pubSeed: v.pubSeed }, v.digest, v.envelope)).toBe(v.leaf);
  });

  test("the approval vector's digest is the EIP-712 digest of its fields", () => {
    const v = generated.vectors[2]!;
    const a = v.approval!;
    expect(
      approvalDigest(a.chainId, a.account, {
        nonce: BigInt(a.nonce),
        to: a.to,
        value: BigInt(a.value),
        data: a.data,
        maxFeeWei: BigInt(a.maxFeeWei),
        validUntil: BigInt(a.validUntil),
      }),
    ).toBe(v.digest);
  });
});
