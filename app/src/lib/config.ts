// What the app needs to know about the chain, served by the operator (GET /operator/config) so a
// redeploy shows up without rebuilding the app.

import type { Abi, Address, Hex } from "viem";
import type { stealth } from "@postcurve/sdk";

export type StealthDeployment = {
  chainId: number;
  rpcUrl: string;
  sidecarUrl: string;
  frameOps: Address;
  paymaster: Address;
  factory: Address;
  token: Address;
  announcer: Address;
  registry: Address;
};

export type AppConfig = {
  chainId: number;
  deployment: StealthDeployment;
  accountCreationCode: Hex;
  abi: { token: Abi; paymaster: Abi; account: Abi; factory: Abi; announcer: Abi };
};

let cached: Promise<AppConfig> | null = null;

export function loadConfig(): Promise<AppConfig> {
  cached ??= fetch("/operator/config").then(async (r) => {
    if (!r.ok) throw new Error(`operator answered ${r.status}`);
    return (await r.json()) as AppConfig;
  });
  cached.catch(() => (cached = null));
  return cached;
}

export const deploymentId = (cfg: AppConfig) => `${cfg.chainId}:${cfg.deployment.paymaster.toLowerCase()}`;

/** The SDK's view of the deployment, for stealth address derivation and scanning. */
export const sdkDeployment = (cfg: AppConfig): stealth.Deployment => ({
  factory: cfg.deployment.factory,
  accountCreationCode: cfg.accountCreationCode,
  paymaster: cfg.deployment.paymaster,
  frameOps: cfg.deployment.frameOps,
});
