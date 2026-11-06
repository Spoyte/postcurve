// Sender side: derive a fresh stealth address for a meta-address (pq-sap §3).

import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { bytesToHex, type Address, type Hex } from "viem";
import { decodeMetaAddress } from "./metaAddress";
import { commitment, opener, stealthAddress, viewTag, type Deployment } from "./profile";

export function send(
  meta: Hex,
  d: Deployment,
): { address: Address; ephemeralPubKey: Hex; viewTag: number; opener: Hex } {
  const decoded = decodeMetaAddress(meta);
  if (!decoded) throw new Error("not a 0x02 meta-address of 1,217 bytes");
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(decoded.ek);
  const op = opener(sharedSecret);
  return {
    address: stealthAddress(commitment(decoded.spendKey, op), d),
    ephemeralPubKey: bytesToHex(cipherText),
    viewTag: viewTag(sharedSecret),
    opener: op,
  };
}
