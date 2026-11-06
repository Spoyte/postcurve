// Generates spec/vectors/wots-xmss-v1.json, the vectors every implementation must pass.
// Run: bun scripts/gen-vectors.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";
import { approvalDigest, buildTree, identityOf, signEnvelope } from "../src";

export const VECTORS_PATH = fileURLToPath(
  new URL("../../spec/vectors/wots-xmss-v1.json", import.meta.url),
);

type ApprovalFields = {
  chainId: number;
  account: Address;
  nonce: string;
  to: Address;
  value: string;
  data: Hex;
  maxFeeWei: string;
  validUntil: string;
};

export type Vector = {
  name: string;
  seed: Hex;
  pubSeed: Hex;
  root: Hex;
  leaf: number;
  digest: Hex;
  envelope: Hex;
  approval: ApprovalFields | null;
};

export type VectorFile = { version: 1; note: string; vectors: Vector[] };

const seedA = keccak256(toHex("postcurve test seed A"));
const seedB = keccak256(toHex("postcurve test seed B"));

const approvalB: ApprovalFields = {
  chainId: 1337,
  account: "0x00000000000000000000000000000000000000b0",
  nonce: "1",
  to: "0x8943545177806ED17B9F23F0a21ee5948eCaa776",
  value: (10n ** 15n).toString(),
  data: "0x",
  maxFeeWei: (10n ** 16n).toString(),
  validUntil: "2000000000",
};

function vector(name: string, seed: Hex, leaf: number, digest: Hex, approval: ApprovalFields | null): Vector {
  const seedBytes = hexToBytes(seed);
  const tree = buildTree(seedBytes);
  const { root, pubSeed } = identityOf(tree);
  return { name, seed, pubSeed, root, leaf, digest, envelope: signEnvelope(seedBytes, tree, leaf, digest), approval };
}

export function generateVectors(): VectorFile {
  const digestB = approvalDigest(approvalB.chainId, approvalB.account, {
    nonce: BigInt(approvalB.nonce),
    to: approvalB.to,
    value: BigInt(approvalB.value),
    data: approvalB.data,
    maxFeeWei: BigInt(approvalB.maxFeeWei),
    validUntil: BigInt(approvalB.validUntil),
  });
  return {
    version: 1,
    note: "TEST KEYS ONLY. Never use these seeds for funds.",
    vectors: [
      vector("A-leaf0", seedA, 0, keccak256(toHex("vector A0")), null),
      vector("A-leaf255", seedA, 255, keccak256(toHex("vector A255")), null),
      vector("B-leaf7-approval", seedB, 7, digestB, approvalB),
    ],
  };
}

export function serializeVectors(file: VectorFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

if (import.meta.main) {
  mkdirSync(dirname(VECTORS_PATH), { recursive: true });
  writeFileSync(VECTORS_PATH, serializeVectors(generateVectors()));
  console.log(`wrote ${VECTORS_PATH}`);
}
