// Key states for the Keys screen, and the plain-language refusal for a reused key.
import { describe, expect, test } from "bun:test";
import { explainRefusal, mergeKeyStates } from "../src/lib/keyGrid";

describe("mergeKeyStates", () => {
  test("on chain wins; a locally used key that never landed is 'local'", () => {
    const onchain = Array.from({ length: 256 }, (_, i) => i < 2);
    const s = mergeKeyStates(onchain, [0, 1, 2]);
    expect(s.length).toBe(256);
    expect(s.slice(0, 4)).toEqual(["onchain", "onchain", "local", "unused"]);
    expect(s.filter((x) => x === "unused").length).toBe(253);
  });

  test("on-chain keys the browser doesn't know about still show as used", () => {
    const onchain = Array.from({ length: 256 }, (_, i) => i === 7);
    expect(mergeKeyStates(onchain, [])[7]).toBe("onchain");
  });
});

describe("explainRefusal", () => {
  const raw = (n: number) => `validation frame 1: reverted with data 0x94064f91${n.toString(16).padStart(64, "0")}`;
  test("Rejected(4) and Rejected(5) are key reuse", () => {
    expect(explainRefusal(raw(4))).toBe("Refused: these one-time keys were already used");
    expect(explainRefusal(raw(5))).toBe("Refused: these one-time keys were already used");
  });
  test("anything else passes through", () => {
    expect(explainRefusal(raw(20))).toBe(raw(20));
    expect(explainRefusal("network down")).toBe("network down");
  });
});
