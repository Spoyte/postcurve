// The payment link carries the 1,217-byte meta-address; anything else must not be payable.
import { describe, expect, test } from "bun:test";
import { stealth } from "@postcurve/sdk";
import { decodePayLink, encodePayLink } from "../src/lib/link";

const ID = { root: `0x${"11".repeat(32)}`, pubSeed: `0x${"22".repeat(32)}` } as const;
const { ek } = stealth.viewKeyFromSeed(new Uint8Array(32).fill(9));
const META = stealth.encodeMetaAddress(stealth.spendKey(2, [ID, ID, ID]), ek);
const ORIGIN = "http://localhost:5173";

describe("payment link", () => {
  test("round trip of a real meta-address", () => {
    const link = encodePayLink(ORIGIN, META);
    expect(link.startsWith(`${ORIGIN}/#/pay?to=`)).toBe(true);
    expect(link.split("?to=")[1]).not.toMatch(/[+/=]/);
    expect(decodePayLink(link)).toBe(META);
    expect(decodePayLink(new URL(link).hash)).toBe(META);
  });

  test("decodePayLink rejects", () => {
    const link = encodePayLink(ORIGIN, META);
    expect(decodePayLink(link.slice(0, -1))).toBeNull();
    const v3 = `0x03${META.slice(4)}` as const;
    expect(decodePayLink(encodePayLink(ORIGIN, v3))).toBeNull();
    expect(decodePayLink(`${ORIGIN}/#/pay?to=!!!not-base64!!!`)).toBeNull();
    expect(decodePayLink(`${ORIGIN}/#/pay?to=`)).toBeNull();
    expect(decodePayLink(`${ORIGIN}/#/pay`)).toBeNull();
  });
});
