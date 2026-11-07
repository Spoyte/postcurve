// The phone relay: pairs can't see each other's requests, each request gets one answer, only the app may write.
import { describe, expect, test } from "bun:test";
import { operatorHandler, type OperatorDeps } from "../operator";
import { createRelay } from "../relay";

const APP = "http://localhost:5173";
const request = {
  chainId: 1337,
  account: "0x00000000000000000000000000000000000000b0",
  approval: { nonce: "0", token: "0x0000000000000000000000000000000000000c0c", to: "0x8943545177806ED17B9F23F0a21ee5948eCaa776", amount: "24000000", maxFee: "1000000", validUntil: "2000000000" },
};
const ID = { root: `0x${"11".repeat(32)}`, pubSeed: `0x${"22".repeat(32)}` };
const A = "a".repeat(32);
const B = "b".repeat(32);

function handler() {
  const deps: OperatorDeps = {
    config: () => ({}) as any,
    deploy: async () => ({ address: "0x00000000000000000000000000000000000000c3", txHash: null }),
    faucet: async () => ({ ethTx: "0x01", mintTx: "0x02" }),
    relay: createRelay(),
  };
  const h = operatorHandler(deps);
  return (path: string, method = "GET", body?: unknown, origin: string | null = method === "GET" ? null : APP) =>
    h(new Request(`http://127.0.0.1:8791${path}`, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
}

describe("relay", () => {
  test("a request posted to pair A is not visible from pair B", async () => {
    const call = handler();
    const r = await call(`/relay/${A}/requests`, "POST", { request });
    expect(r.status).toBe(200);
    expect((await call(`/relay/${B}/requests/next`)).status).toBe(204);
    const next = await call(`/relay/${A}/requests/next`);
    expect(next.status).toBe(200);
    expect((await next.json()).request.approval.amount).toBe("24000000");
  });

  test("a request gets one answer; a second one is 409", async () => {
    const call = handler();
    const { requestId } = await (await call(`/relay/${A}/requests`, "POST", { request })).json();
    expect((await call(`/relay/${A}/responses/${requestId}`)).status).toBe(204);
    expect((await call(`/relay/${A}/responses/${requestId}`, "POST", { leaf: 0, envelope: "0x01", identity: ID })).status).toBe(200);
    expect((await call(`/relay/${A}/responses/${requestId}`, "POST", { refused: true })).status).toBe(409);
    expect((await (await call(`/relay/${A}/responses/${requestId}`)).json()).leaf).toBe(0);
    expect((await call(`/relay/${A}/requests/next`)).status).toBe(204);
  });

  test("identity: unknown pair is 404, set once", async () => {
    const call = handler();
    expect((await call(`/relay/${A}/identity`)).status).toBe(404);
    expect((await call(`/relay/${A}/identity`, "POST", { identity: ID })).status).toBe(200);
    expect((await call(`/relay/${A}/identity`, "POST", { identity: ID })).status).toBe(409);
    expect((await (await call(`/relay/${A}/identity`)).json()).root).toBe(ID.root);
  });

  test("a POST with a foreign Origin is 403", async () => {
    const call = handler();
    expect((await call(`/relay/${A}/requests`, "POST", { request }, "https://evil.example")).status).toBe(403);
  });

  test("a malformed request is 400 and a bad pair id is 400", async () => {
    const call = handler();
    expect((await call(`/relay/${A}/requests`, "POST", { request: { chainId: 1 } })).status).toBe(400);
    expect((await call(`/relay/not-a-pair/requests/next`)).status).toBe(400);
  });

  test("the 17th open request is refused", async () => {
    const call = handler();
    for (let i = 0; i < 16; i++) expect((await call(`/relay/${A}/requests`, "POST", { request })).status).toBe(200);
    expect((await call(`/relay/${A}/requests`, "POST", { request })).status).toBe(429);
  });
});
