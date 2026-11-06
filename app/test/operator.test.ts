// The operator only acts for the app's own pages, and validates what it is asked to do.
import { describe, expect, test } from "bun:test";
import { operatorHandler, type OperatorDeps } from "../operator";

const APP = "http://localhost:5173";
const EVIL = "https://evil.example";

function fakeDeps() {
  const calls: string[] = [];
  const deps: OperatorDeps = {
    config: () => ({ chainId: 1337 }) as any,
    deploy: async (c) => {
      calls.push(`deploy ${c}`);
      return { address: "0x00000000000000000000000000000000000000c3", txHash: null };
    },
    faucet: async (a) => {
      calls.push(`faucet ${a}`);
      return { ethTx: "0x01", mintTx: "0x02" };
    },
  };
  return { deps, calls };
}

const req = (path: string, method: string, origin: string | null, body?: unknown) =>
  new Request(`http://127.0.0.1:8791${path}`, {
    method,
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("operator", () => {
  test("rejects a foreign origin: the faucet sends nothing", async () => {
    const { deps, calls } = fakeDeps();
    const r = await operatorHandler(deps)(req("/faucet", "POST", EVIL, { address: "0x8943545177806ED17B9F23F0a21ee5948eCaa776" }));
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("a deploy for a commitment that isn't 32 bytes is 400", async () => {
    const { deps, calls } = fakeDeps();
    const r = await operatorHandler(deps)(req("/deploy", "POST", APP, { commitment: "0x1234" }));
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("a faucet request for a bad address is 400", async () => {
    const { deps, calls } = fakeDeps();
    const r = await operatorHandler(deps)(req("/faucet", "POST", APP, { address: "bob" }));
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("the app can deploy and fund; GET /config needs no origin", async () => {
    const { deps, calls } = fakeDeps();
    const h = operatorHandler(deps);
    const c = `0x${"ab".repeat(32)}`;
    expect((await h(req("/deploy", "POST", APP, { commitment: c }))).status).toBe(200);
    expect((await h(req("/faucet", "POST", APP, { address: "0x8943545177806ED17B9F23F0a21ee5948eCaa776" }))).status).toBe(200);
    expect(calls).toEqual([`deploy ${c}`, "faucet 0x8943545177806ED17B9F23F0a21ee5948eCaa776"]);
    const cfg = await h(req("/config", "GET", null));
    expect(cfg.status).toBe(200);
    expect((await cfg.json()).chainId).toBe(1337);
  });
});
