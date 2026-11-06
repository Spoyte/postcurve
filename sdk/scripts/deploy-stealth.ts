// Deploys the stealth core on the local EIP-8141 devnet (devnet/README.md) and stakes the paymaster.
// Writes devnet/data/stealth-deployment.json (gitignored). Needs `forge build` in contracts/ first.
//
//   bun scripts/deploy-stealth.ts
//
// Keys come from devnet/data/keys/accounts.json and are never printed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
export const DEPLOYMENT_PATH = root("devnet/data/stealth-deployment.json");
export const PAYMASTER_MIN_FEE = 500_000n; // 0.50 tUSDC
export const PAYMASTER_MAX_SPONSORED_WEI = parseEther("0.01");

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

export function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const path = root(`contracts/out/${file}/${name}.json`);
  if (!existsSync(path)) throw new Error(`${path} missing: run forge build in contracts/`);
  const j = JSON.parse(readFileSync(path, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export function devnetConfig() {
  const d = JSON.parse(readFileSync(root("devnet/data/devnet.json"), "utf8"));
  const chain = defineChain({
    id: d.chainId,
    name: "postcurve local devnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [d.rpcUrl] } },
  });
  return { chain, rpcUrl: d.rpcUrl as string, sidecarUrl: d.sidecarUrl as string, registry: d.stakingRegistry as Address };
}

/** Reads one funded devnet key by name; the key never leaves this process. */
export function devnetKey(name: string): Hex {
  const accounts = JSON.parse(readFileSync(root("devnet/data/keys/accounts.json"), "utf8")) as {
    name: string;
    privateKey: Hex;
  }[];
  const a = accounts.find((x) => x.name === name);
  if (!a) throw new Error(`no devnet account named ${name}`);
  return a.privateKey;
}

async function main() {
  const { chain, rpcUrl, sidecarUrl, registry } = devnetConfig();
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const account = privateKeyToAccount(devnetKey("deployer"));
  const wallet = createWalletClient({ chain, transport: http(rpcUrl), account });
  const gasPrice = 2n * (await pub.getGasPrice());

  // Contract creation pays EIP-8037 state gas per byte on this devnet: big contracts need a big limit.
  async function deploy(file: string, name: string, args: unknown[] = [], gas = 15_000_000n): Promise<Address> {
    const { abi, bytecode } = artifact(file, name);
    const hash = await wallet.deployContract({ abi, bytecode, args, type: "legacy", gasPrice, gas });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deployment failed (${hash})`);
    console.log(`${name.padEnd(20)} ${r.contractAddress}`);
    return r.contractAddress;
  }

  async function send(to: Address, value: bigint, data?: Hex) {
    const hash = await wallet.sendTransaction({ to, value, data, type: "legacy", gasPrice, gas: 500_000n });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`tx to ${to} failed (${hash})`);
  }

  const frameOps = await deploy("FrameOps.sol", "FrameOps");
  const token = await deploy("TestUSDC.sol", "TestUSDC");
  // the paymaster sponsors tUSDC spends only, for at least 0.50 tUSDC, at most 0.01 ETH of gas per tx
  const paymaster = await deploy(
    "PostcurvePaymaster.sol",
    "PostcurvePaymaster",
    [frameOps, registry, token, PAYMASTER_MIN_FEE, PAYMASTER_MAX_SPONSORED_WEI],
    50_000_000n,
  );
  const announcer = await deploy("ERC5564Announcer.sol", "ERC5564Announcer");

  const pm = artifact("PostcurvePaymaster.sol", "PostcurvePaymaster");
  const factory = (await pub.readContract({ address: paymaster, abi: pm.abi, functionName: "FACTORY" })) as Address;
  console.log(`${"StealthBunkerFactory".padEnd(20)} ${factory}`);

  await send(paymaster, parseEther("1"));
  await send(paymaster, parseEther("0.02"), encodeFunctionData({ abi: pm.abi, functionName: "stake" }));

  // checks: every contract has code, and the registry reports the paymaster's stake
  for (const [name, addr] of Object.entries({ frameOps, paymaster, factory, token, announcer })) {
    const code = await pub.getCode({ address: addr });
    if (!code || code === "0x") throw new Error(`${name} has no code at ${addr}`);
  }
  const [stake, delay, withdrawTime] = (await pub.readContract({
    address: registry,
    abi: [
      {
        type: "function",
        name: "getDepositInfo",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [
          { name: "stake", type: "uint256" },
          { name: "unstakeDelaySec", type: "uint32" },
          { name: "withdrawTime", type: "uint64" },
        ],
      },
    ],
    functionName: "getDepositInfo",
    args: [paymaster],
  })) as [bigint, number, bigint];
  if (stake < parseEther("0.02") || delay < 86400 || withdrawTime !== 0n) {
    throw new Error(`paymaster not staked: stake ${formatEther(stake)}, delay ${delay}, withdraw ${withdrawTime}`);
  }
  console.log(`paymaster staked ${formatEther(stake)} ETH (delay ${delay}s), balance ${formatEther(await pub.getBalance({ address: paymaster }))} ETH`);

  const out: StealthDeployment = { chainId: chain.id, rpcUrl, sidecarUrl, frameOps, paymaster, factory, token, announcer, registry };
  writeFileSync(DEPLOYMENT_PATH, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${DEPLOYMENT_PATH}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
