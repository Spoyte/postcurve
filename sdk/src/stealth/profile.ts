// The postcurve pq-sap account profile `postcurve-wots-xmss-quorum/v0`. See spec/stealth-profile.md.
// The derivations follow pq-sap's commitment format 0x02 (TECHNICAL_SPEC §3-4, commit dd18e5f).

import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concat,
  concatHex,
  encodeAbiParameters,
  getContractAddress,
  hexToBytes,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import type { Identity } from "../xmss";

export type Domains = { open: string; commit: string };

export const PROFILE = {
  name: "postcurve-wots-xmss-quorum/v0",
  keyDomain: "postcurve/quorum/key/v0",
  viewKeyDomain: "postcurve/view-key/v0",
  domains: {
    open: "postcurve/wots-xmss-quorum/open/v0",
    commit: "postcurve/wots-xmss-quorum/commit/v0",
  },
} as const;

/** Where stealth accounts live: the CREATE2 factory, the account's creation code and its constructor args. */
export type Deployment = {
  factory: Address;
  accountCreationCode: Hex;
  paymaster: Address;
  frameOps: Address;
};

const ZERO_SALT: Hex = `0x${"00".repeat(32)}`;
const utf8 = (s: string) => new TextEncoder().encode(s);

const QUORUM_ABI = [
  { type: "uint256" },
  {
    type: "tuple[]",
    components: [
      { name: "root", type: "bytes32" },
      { name: "pubSeed", type: "bytes32" },
    ],
  },
] as const;

/** spend_key = keccak256(key domain || abi.encode(threshold, identities)). Identity order matters. */
export function spendKey(threshold: number, ids: Identity[]): Hex {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > ids.length) {
    throw new RangeError(`threshold ${threshold} must be between 1 and ${ids.length}`);
  }
  const encoded = encodeAbiParameters(QUORUM_ABI, [BigInt(threshold), ids]);
  return keccak256(concat([utf8(PROFILE.keyDomain), hexToBytes(encoded)]));
}

/** opener = SHA-256(open domain || ss). Domains are explicit: a wrong set derives wrong destinations. */
export function deriveOpener(domains: Domains, ss: Uint8Array): Hex {
  return bytesToHex(sha256(concat([utf8(domains.open), ss])));
}

/** commitment = keccak256(commit domain || spend_key || opener). */
export function deriveCommitment(domains: Domains, spendKeyHex: Hex, openerHex: Hex): Hex {
  return keccak256(concat([utf8(domains.commit), hexToBytes(spendKeyHex), hexToBytes(openerHex)]));
}

export const opener = (ss: Uint8Array): Hex => deriveOpener(PROFILE.domains, ss);
export const commitment = (spendKeyHex: Hex, openerHex: Hex): Hex =>
  deriveCommitment(PROFILE.domains, spendKeyHex, openerHex);

/** view_tag = SHA-256(ss)[0]: a post-decapsulation filter, never proof of a payment. */
export function viewTag(ss: Uint8Array): number {
  return sha256(ss)[0]!;
}

/** CREATE2(factory, salt 0, keccak256(creationCode || abi.encode(commitment, paymaster, frameOps))). */
export function stealthAddress(commitmentHex: Hex, d: Deployment): Address {
  const args = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "address" }],
    [commitmentHex, d.paymaster, d.frameOps],
  );
  return getContractAddress({
    opcode: "CREATE2",
    from: d.factory,
    salt: ZERO_SALT,
    bytecode: concatHex([d.accountCreationCode, args]),
  });
}
