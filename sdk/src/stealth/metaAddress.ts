// pq-sap commitment-format meta-address: 0x02 || spend_key (32) || ML-KEM-768 ek (1184) = 1217 bytes.

import { bytesToHex, hexToBytes, type Hex } from "viem";

export const META_VERSION = 0x02;
export const EK_BYTES = 1184;
export const META_BYTES = 1 + 32 + EK_BYTES;

export function encodeMetaAddress(spendKey: Hex, ek: Uint8Array): Hex {
  const sk = hexToBytes(spendKey);
  if (sk.length !== 32 || ek.length !== EK_BYTES) throw new RangeError("spend key must be 32 bytes and ek 1184");
  return bytesToHex(new Uint8Array([META_VERSION, ...sk, ...ek]));
}

/** Null unless the meta-address is exactly 1,217 bytes with version byte 0x02. */
export function decodeMetaAddress(meta: Hex): { spendKey: Hex; ek: Uint8Array } | null {
  try {
    const b = hexToBytes(meta);
    if (b.length !== META_BYTES || b[0] !== META_VERSION) return null;
    return { spendKey: bytesToHex(b.slice(1, 33)), ek: b.slice(33) };
  } catch {
    return null;
  }
}
