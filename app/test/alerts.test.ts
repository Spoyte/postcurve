// The alert bar shows only alerts this browser hasn't seen, newest first.
import { describe, expect, test } from "bun:test";
import { unseenAlerts } from "../src/lib/alerts";

const alert = (id: string, raisedAt: number) => ({ id, raisedAt }) as any;

describe("unseenAlerts", () => {
  test("unseen only, newest first", () => {
    const out = unseenAlerts([alert("a", 10), alert("b", 30), alert("c", 20)], ["a"]);
    expect(out.map((a) => a.id)).toEqual(["b", "c"]);
  });
  test("nothing", () => {
    expect(unseenAlerts([], [])).toEqual([]);
    expect(unseenAlerts([alert("a", 1)], ["a"])).toEqual([]);
  });
});
