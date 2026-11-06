// Generates spec/vectors/stealth-v0.json: the stealth profile and TransferApproval values the
// Solidity libraries must reproduce. Run: bun scripts/gen-stealth-vectors.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";
import { buildTree, identityOf, type Identity } from "../src/xmss";
import { commitment, opener, spendKey } from "../src/stealth";
import { transferApprovalDigest } from "../src/transferApproval";

export const STEALTH_VECTORS_PATH = fileURLToPath(new URL("../../spec/vectors/stealth-v0.json", import.meta.url));

export type StealthVectors = {
  version: 0;
  profile: string;
  note: string;
  identities: Identity[];
  threshold: number;
  spendKey: Hex;
  sharedSecret: Hex;
  opener: Hex;
  commitment: Hex;
  approval: {
    chainId: number;
    account: Address;
    nonce: string;
    token: Address;
    to: Address;
    amount: string;
    maxFee: string;
    validUntil: string;
    digest: Hex;
  };
};

export function generateStealthVectors(): StealthVectors {
  const identities = [1, 2, 3].map((i) =>
    identityOf(buildTree(hexToBytes(keccak256(toHex(`postcurve stealth test approver ${i}`))))),
  );
  const threshold = 2;
  const sk = spendKey(threshold, identities);
  const ss = hexToBytes(keccak256(toHex("postcurve stealth test shared secret")));
  const op = opener(ss);
  const a = {
    chainId: 1337,
    account: "0x00000000000000000000000000000000000000b0" as Address,
    nonce: 0n,
    token: "0x0000000000000000000000000000000000000c0c" as Address,
    to: "0x8943545177806ED17B9F23F0a21ee5948eCaa776" as Address,
    amount: 24_000_000n,
    maxFee: 1_000_000n,
    validUntil: 2_000_000_000n,
  };
  return {
    version: 0,
    profile: "postcurve-wots-xmss-quorum/v0",
    note: "TEST KEYS ONLY. Never use these seeds for funds.",
    identities,
    threshold,
    spendKey: sk,
    sharedSecret: toHex(ss),
    opener: op,
    commitment: commitment(sk, op),
    approval: {
      chainId: a.chainId,
      account: a.account,
      nonce: a.nonce.toString(),
      token: a.token,
      to: a.to,
      amount: a.amount.toString(),
      maxFee: a.maxFee.toString(),
      validUntil: a.validUntil.toString(),
      digest: transferApprovalDigest(a.chainId, a.account, a),
    },
  };
}

export function serializeStealthVectors(v: StealthVectors): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

if (import.meta.main) {
  mkdirSync(dirname(STEALTH_VECTORS_PATH), { recursive: true });
  writeFileSync(STEALTH_VECTORS_PATH, serializeStealthVectors(generateStealthVectors()));
  console.log(`wrote ${STEALTH_VECTORS_PATH}`);
}
