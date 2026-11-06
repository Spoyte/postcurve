// Reads go to the devnet through /rpc; frame transactions go to the alt mempool sidecar through /sidecar.

import { createPublicClient, defineChain, http, type PublicClient } from "viem";
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
