// A private payment link: <origin>/#/pay?to=<the 1,217-byte meta-address, base64url, no padding>.

import { bytesToHex, hexToBytes, type Hex } from "viem";
import { stealth } from "@postcurve/sdk";

const B64URL = /^[A-Za-z0-9_-]+$/;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array | null {
  if (!B64URL.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function encodePayLink(origin: string, meta: Hex): string {
  return `${origin.replace(/\/+$/, "")}/#/pay?to=${toBase64Url(hexToBytes(meta))}`;
}

/** The meta-address in a payment link (a full URL, a hash or a query), or null if it isn't a valid one. */
export function decodePayLink(hashOrUrl: string): Hex | null {
  const m = /[?&]to=([^&#]*)/.exec(hashOrUrl);
  if (!m || !m[1]) return null;
  const bytes = fromBase64Url(m[1]);
  if (!bytes || bytes.length !== stealth.META_BYTES) return null;
  const meta = bytesToHex(bytes);
  return stealth.decodeMetaAddress(meta) ? meta : null;
}
