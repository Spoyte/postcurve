import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generateStealthVectors, serializeStealthVectors, STEALTH_VECTORS_PATH } from "../../scripts/gen-stealth-vectors";

describe("stealth vectors", () => {
  test("committed file byte-equals a fresh generation", () => {
    expect(readFileSync(STEALTH_VECTORS_PATH, "utf8")).toBe(serializeStealthVectors(generateStealthVectors()));
  });
});
