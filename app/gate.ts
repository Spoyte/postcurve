// What the public demo URL lets through (Task 13): only the JSON-RPC methods the app uses, and a
// rate-limited faucet. Notably refused: ethrex_submitPrivilegedFrameTransaction, which mines a frame
// transaction without any mempool rules, and every debug_/admin_/txpool_/engine_ method.

export const ETH_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getLogs",
  "eth_sendRawTransaction",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
]);

export const SIDECAR_METHODS: ReadonlySet<string> = new Set(["eth_sendFrameTransaction", "eth_chainId"]);

const MAX_BATCH = 50;

export function allowRpc(body: unknown, allowed: ReadonlySet<string>): boolean {
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH) return false;
  return calls.every((c) => typeof c === "object" && c !== null && typeof (c as { method?: unknown }).method === "string" && allowed.has((c as { method: string }).method));
}

/** One address once per 10 minutes, and at most 30 faucet payouts an hour overall. */
export function faucetLimiter(now: () => number = Date.now): (address: string) => boolean {
  const last = new Map<string, number>();
  let hour: number[] = [];
  return (address) => {
    const t = now();
    const a = address.toLowerCase();
    const prev = last.get(a);
    if (prev !== undefined && t - prev < 10 * 60_000) return false;
    hour = hour.filter((x) => t - x < 60 * 60_000);
    if (hour.length >= 30) return false;
    last.set(a, t);
    hour.push(t);
    return true;
  };
}

/** Deploys cost ~11M gas each: the operator only deploys an account that already holds a payment. */
export async function guardDeploy(address: string, balanceOf: (address: string) => Promise<bigint>): Promise<void> {
  if ((await balanceOf(address)) === 0n) throw new Error(`${address} holds no payment: nothing to deploy for`);
}
