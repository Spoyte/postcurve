// What the public URL lets through: only the RPC methods the app uses, a rate-limited faucet, and
// deploys only for accounts that hold a payment.
import { describe, expect, test } from "bun:test";
import { allowRpc, ETH_METHODS, faucetLimiter, guardDeploy, SIDECAR_METHODS } from "../gate";

const call = (method: string) => ({ jsonrpc: "2.0", id: 1, method, params: [] });

describe("allowRpc", () => {
  test("eth_call is allowed; the privileged frame submission is not", () => {
    expect(allowRpc(call("eth_call"), ETH_METHODS)).toBe(true);
    expect(allowRpc(call("ethrex_submitPrivilegedFrameTransaction"), ETH_METHODS)).toBe(false);
    expect(allowRpc(call("debug_traceTransaction"), ETH_METHODS)).toBe(false);
    expect(allowRpc(call("admin_peers"), ETH_METHODS)).toBe(false);
  });
  test("a batch passes only if every call is allowed, and at most 50", () => {
    expect(allowRpc([call("eth_call"), call("eth_blockNumber")], ETH_METHODS)).toBe(true);
    expect(allowRpc([call("eth_call"), call("debug_traceTransaction")], ETH_METHODS)).toBe(false);
    expect(allowRpc(Array.from({ length: 51 }, () => call("eth_call")), ETH_METHODS)).toBe(false);
    expect(allowRpc([], ETH_METHODS)).toBe(false);
  });
  test("not JSON-RPC is refused", () => {
    expect(allowRpc("not json", ETH_METHODS)).toBe(false);
    expect(allowRpc(null, ETH_METHODS)).toBe(false);
    expect(allowRpc({ method: 42 }, ETH_METHODS)).toBe(false);
  });
  test("the sidecar only takes frame transactions", () => {
    expect(allowRpc(call("eth_sendFrameTransaction"), SIDECAR_METHODS)).toBe(true);
    expect(allowRpc(call("eth_sendFrameTransaction"), ETH_METHODS)).toBe(false);
    expect(allowRpc(call("eth_sendRawTransaction"), SIDECAR_METHODS)).toBe(false);
  });
});

describe("faucetLimiter", () => {
  test("one address once per 10 minutes, at most 30 an hour", () => {
    let t = 0;
    const allow = faucetLimiter(() => t);
    expect(allow("0xa")).toBe(true);
    t += 9 * 60_000;
    expect(allow("0xA")).toBe(false);
    t += 2 * 60_000;
    expect(allow("0xa")).toBe(true);
    for (let i = 0; i < 28; i++) expect(allow(`0x${i}b`)).toBe(true);
    expect(allow("0xfff")).toBe(false);
    t += 61 * 60_000;
    expect(allow("0xfff")).toBe(true);
  });
});

describe("guardDeploy", () => {
  test("a commitment whose address holds no tUSDC is refused; one holding a payment is allowed", async () => {
    const balances: Record<string, bigint> = { "0x00000000000000000000000000000000000000c3": 25_000_000n };
    const balanceOf = async (a: string) => balances[a] ?? 0n;
    let refused = "";
    try {
      await guardDeploy("0x00000000000000000000000000000000000000ee", balanceOf);
    } catch (e) {
      refused = (e as Error).message;
    }
    expect(refused).toContain("holds no payment");
    await guardDeploy("0x00000000000000000000000000000000000000c3", balanceOf);
  });
});
