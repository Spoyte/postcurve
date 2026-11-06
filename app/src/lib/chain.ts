// Reads go to the devnet through /rpc; frame transactions go to the alt mempool sidecar through /sidecar.

import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rpc } from "@forshtat/hegota-support/rpc";
import type { AppConfig } from "./config";

const abs = (path: string) => new URL(path, globalThis.location?.origin ?? "http://localhost:5173").toString();

export function devnetChain(cfg: AppConfig) {
  return defineChain({
    id: cfg.chainId,
    name: "postcurve local devnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [abs("/rpc")] } },
  });
}

let client: PublicClient | null = null;

export function publicClient(cfg: AppConfig): PublicClient {
  client ??= createPublicClient({ chain: devnetChain(cfg), transport: http(abs("/rpc"), { batch: { batchSize: 128 } }) });
  return client;
}

export function sidecarRpc<T = any>(method: string, params: unknown[]): Promise<T> {
  return rpc(abs("/sidecar"), method, params) as Promise<T>;
}

export { abs };

/** A legacy transaction signed in this browser (Bob's ordinary ECDSA test account), at 2x gas price as in e2e. */
export async function sendLegacy(cfg: AppConfig, key: Hex, to: Address, data: Hex, gas = 3_000_000n): Promise<Hex> {
  const pub = publicClient(cfg);
  const wallet = createWalletClient({ chain: devnetChain(cfg), transport: http(abs("/rpc")), account: privateKeyToAccount(key) });
  const gasPrice = 2n * (await pub.getGasPrice());
  const hash = await wallet.sendTransaction({ to, data, type: "legacy", gasPrice, gas });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return hash;
}

export async function tokenBalance(cfg: AppConfig, who: Address): Promise<bigint> {
  return (await publicClient(cfg).readContract({
    address: cfg.deployment.token,
    abi: cfg.abi.token,
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}
