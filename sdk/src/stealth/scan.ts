// Recipient side: recognise a payment from an ERC-5564 announcement (pq-sap §3).

import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { hexToBytes, type Address, type Hex } from "viem";
import { deriveCommitment, deriveOpener, PROFILE, stealthAddress, viewTag, type Deployment, type Domains } from "./profile";

export type Announcement = { stealthAddress: Address; ephemeralPubKey: Hex; metadata: Hex };

const CT_BYTES = 1088;

/** Returns the opener when the announcement pays this recipient, else null. Never throws. */
export function scanWith(
  domains: Domains,
  dk: Uint8Array,
  spendKey: Hex,
  d: Deployment,
  ann: Announcement,
): { opener: Hex } | null {
  try {
    const ct = hexToBytes(ann.ephemeralPubKey);
    if (ct.length !== CT_BYTES) return null;
    const ss = ml_kem768.decapsulate(ct, dk);
    const tag = hexToBytes(ann.metadata)[0];
    if (tag !== viewTag(ss)) return null;
    const op = deriveOpener(domains, ss);
    const address = stealthAddress(deriveCommitment(domains, spendKey, op), d);
    return address.toLowerCase() === ann.stealthAddress.toLowerCase() ? { opener: op } : null;
  } catch {
    return null;
  }
}

export function scan(dk: Uint8Array, spendKey: Hex, d: Deployment, ann: Announcement): { opener: Hex } | null {
  return scanWith(PROFILE.domains, dk, spendKey, d, ann);
}
