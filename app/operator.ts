// The postcurve operator (local devnet only): serves the app its configuration, deploys a stealth
// account right before its spend (the sponsor deploy in docs/design.md), and funds Bob's fresh
// browser account, so no devnet private key ever reaches a browser. Keys are read through
// devnetKey() and never printed. Only the app's pages may ask it to act (localOrigin.ts).
//
//   bun operator.ts          (127.0.0.1:8791; `bun run dev` starts it with the app)

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  isHex,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact, DEPLOYMENT_PATH, devnetConfig, devnetKey } from "../sdk/scripts/deploy-stealth";
import { originAllowed } from "../sdk/scripts/localOrigin";
import { guardDeploy } from "./gate";
import { createRelay, type Relay } from "./relay";
import type { AppConfig, StealthDeployment } from "./src/lib/config";

export type OperatorDeps = {
  config: () => AppConfig;
  deploy: (commitment: Hex) => Promise<{ address: Address; txHash: Hex | null }>;
  faucet: (address: Address) => Promise<{ ethTx: Hex; mintTx: Hex }>;
  /** The phone approver's relay (relay.ts). */
  relay?: Relay;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return typeof b === "object" && b !== null ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function operatorHandler(deps: OperatorDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (!originAllowed(request.method, request.headers.get("origin"))) return json({ error: "origin not allowed" }, 403);
    try {
      if (request.method === "GET" && path === "/config") return json(deps.config());
      if (request.method === "POST" && path === "/deploy") {
        const { commitment } = await body(request);
        if (typeof commitment !== "string" || !isHex(commitment) || commitment.length !== 66) {
          return json({ error: "commitment must be 32 bytes of hex" }, 400);
        }
        return json(await deps.deploy(commitment));
      }
      if (request.method === "POST" && path === "/faucet") {
        const { address } = await body(request);
        if (typeof address !== "string" || !isAddress(address, { strict: false })) {
          return json({ error: "address must be an address" }, 400);
        }
        return json(await deps.faucet(getAddress(address.toLowerCase())));
      }
      const relayed = deps.relay ? await deps.relay.handle(request, path) : null;
      if (relayed) return relayed;
      return json({ error: `no route for ${request.method} ${path}` }, 404);
    } catch (e) {
      console.error(`[operator] ${request.method} ${path} failed: ${e instanceof Error ? e.message : e}`);
      return json({ error: "the operator could not do that; see its terminal" }, 502);
    }
  };
}

/** One transaction at a time per key, so nonces never collide. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

function realDeps(): OperatorDeps {
  // the SDK carries its own copy of viem: build the chain with ours
  const { chain: sdkChain, rpcUrl } = devnetConfig();
  const chain = defineChain({
    id: sdkChain.id,
    name: "postcurve local devnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const abi = {
    token: artifact("TestUSDC.sol", "TestUSDC").abi,
    paymaster: artifact("PostcurvePaymaster.sol", "PostcurvePaymaster").abi,
    account: artifact("StealthBunkerAccount.sol", "StealthBunkerAccount").abi,
    factory: artifact("StealthBunkerFactory.sol", "StealthBunkerFactory").abi,
    announcer: artifact("ERC5564Announcer.sol", "ERC5564Announcer").abi,
  };
  const accountCreationCode = artifact("StealthBunkerAccount.sol", "StealthBunkerAccount").bytecode;
  const deployment = () => JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as StealthDeployment;
  // keys are re-read on every call: a devnet reset writes new ones, and a cached key would hold no ETH
  const wallets = new Map<string, { send: (to: Address, data?: Hex, value?: bigint, gas?: bigint) => Promise<Hex> }>();
  const wallet = (name: string) => {
    const account = privateKeyToAccount(devnetKey(name));
    const id = `${name}:${account.address}`;
    let w = wallets.get(id);
    if (!w) {
      const client = createWalletClient({ chain, transport: http(rpcUrl), account });
      const queue = serial();
      w = {
        send: (to, data, value = 0n, gas = 3_000_000n) =>
          queue(async () => {
            const gasPrice = 2n * (await pub.getGasPrice());
            const hash = await client.sendTransaction({ to, data, value, type: "legacy", gasPrice, gas });
            const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
            if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
            return hash;
          }),
      };
      wallets.set(id, w);
    }
    return w;
  };

  return {
    relay: createRelay(),
    config: () => ({ chainId: chain.id, deployment: deployment(), accountCreationCode, abi }),
    deploy: async (commitment) => {
      const d = deployment();
      const address = (await pub.readContract({ address: d.factory, abi: abi.factory, functionName: "addressOf", args: [commitment] })) as Address;
      const code = await pub.getCode({ address });
      if (code && code !== "0x") return { address, txHash: null };
      await guardDeploy(address, async (a) =>
        (await pub.readContract({ address: d.token, abi: abi.token, functionName: "balanceOf", args: [a as Address] })) as bigint,
      );
      // ~7 KB of account code pays EIP-8037 state gas on this devnet: give it room
      const data = encodeFunctionData({ abi: abi.factory, functionName: "deploy", args: [commitment] });
      const txHash = await wallet("relayer").send(d.factory, data, 0n, 40_000_000n);
      console.error(`[operator] deployed stealth account ${address} (${txHash})`);
      return { address, txHash };
    },
    faucet: async (address) => {
      const d = deployment();
      // a transfer that creates an account pays EIP-8037 state gas here: 21,000 is not enough
      const ethTx = await wallet("faucet").send(address, undefined, parseEther("0.05"), 500_000n);
      const mintTx = await wallet("deployer").send(
        d.token,
        encodeFunctionData({ abi: abi.token, functionName: "mint", args: [address, 100_000_000n] }),
      );
      console.error(`[operator] funded ${address} with 0.05 ETH and 100 tUSDC`);
      return { ethTx, mintTx };
    },
  };
}

if (import.meta.main) {
  const port = Number(process.env.OPERATOR_PORT ?? 8791);
  Bun.serve({ hostname: "127.0.0.1", port, fetch: operatorHandler(realDeps()) });
  console.error(`postcurve operator (local devnet): listening on http://127.0.0.1:${port} (config, deploy, faucet, phone relay)`);
}
