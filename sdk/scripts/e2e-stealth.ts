// End-to-end stealth spend on the local EIP-8141 devnet (docs/plans/2026-11-06-stealth-core.md, Task 7).
//
//   cd contracts && forge build && cd ../sdk && bun scripts/deploy-stealth.ts && bun scripts/e2e-stealth.ts
//
// Alice receives test USDC at a pq-sap stealth address and spends it with a 2-of-3 hash-only
// approval; the postcurve paymaster pays the gas and takes its fee in test USDC; the patched alt
// mempool sidecar admits the frame transaction. Both approvers here are in-process SDK approvers,
// labelled "software (test)". Exits non-zero at the first failed check. Keys are never printed.

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseAbiItem,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getProfile } from "@forshtat/hegota-support/profiles";
import * as ftx from "@forshtat/hegota-support/tx";
import { rpc, toWire } from "@forshtat/hegota-support/rpc";
import { Approver } from "../src/approver";
import { encodeMetaAddress, scan, send, spendKey, stealthAddress, viewKeyFromSeed, commitment, type Deployment } from "../src/stealth";
import { transferApprovalDigest, type TransferApproval } from "../src/transferApproval";
import { artifact, DEPLOYMENT_PATH, devnetConfig, devnetKey, type StealthDeployment } from "./deploy-stealth";

const profile = getProfile("ethrex-eip8141-tracer");
const MAX_FEE_PER_GAS = 2_000_000_000n; // 2 gwei, as the devnet smoke test uses
const TOKEN_ABI = artifact("TestUSDC.sol", "TestUSDC").abi;
const PM_ABI = artifact("PostcurvePaymaster.sol", "PostcurvePaymaster").abi;
const ACCOUNT_ABI = artifact("StealthBunkerAccount.sol", "StealthBunkerAccount").abi;
const FACTORY_ABI = artifact("StealthBunkerFactory.sol", "StealthBunkerFactory").abi;
const ANNOUNCER_ABI = artifact("ERC5564Announcer.sol", "ERC5564Announcer").abi;
const ANNOUNCEMENT = parseAbiItem(
  "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)",
);

let step = 0;
function check(ok: boolean, what: string, detail = ""): void {
  step++;
  console.log(`${ok ? "PASS" : "FAIL"} ${step}. ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) process.exit(1);
}

async function main() {
  const dep = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as StealthDeployment;
  const { chain, rpcUrl, sidecarUrl } = devnetConfig();
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const gasPrice = 2n * (await pub.getGasPrice());
  const walletOf = (name: string) =>
    createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(devnetKey(name)) });
  async function legacy(name: string, to: Address, data: Hex, gas = 3_000_000n) {
    const hash = await walletOf(name).sendTransaction({ to, data, type: "legacy", gasPrice, gas });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`legacy tx ${hash} reverted`);
    return r;
  }
  const balance = async (token: Address, who: Address) =>
    (await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [who] })) as bigint;

  const deployment: Deployment = {
    factory: dep.factory,
    accountCreationCode: artifact("StealthBunkerAccount.sol", "StealthBunkerAccount").bytecode,
    paymaster: dep.paymaster,
    frameOps: dep.frameOps,
  };

  // 0. the TypeScript address derivation matches the deployed factory (cross-language pin)
  const probe = toHex(randomBytes(32));
  const onchain = (await pub.readContract({ address: dep.factory, abi: FACTORY_ABI, functionName: "addressOf", args: [probe] })) as Address;
  check(onchain.toLowerCase() === stealthAddress(probe, deployment).toLowerCase(), "TS stealth address = factory.addressOf", onchain);

  // 1. Alice: three approvers (browser, device stand-in, paper) and a meta-address
  const seeds = [randomBytes(32), randomBytes(32), randomBytes(32)].map((b) => new Uint8Array(b));
  const [browser, device, paper] = seeds.map((s) => Approver.fromSeed(s));
  const ids = [browser!.identity, device!.identity, paper!.identity];
  const sk = spendKey(2, ids);
  const { ek, dk } = viewKeyFromSeed(seeds[2]!);
  const meta = encodeMetaAddress(sk, ek);
  check(meta.length === 2 + 2 * 1217, "Alice publishes a 2-of-3 meta-address", `${(meta.length - 2) / 2} bytes`);

  // 2. Bob gets test USDC, derives a stealth address, pays it and announces
  const bob = privateKeyToAccount(devnetKey("user1")).address;
  await legacy("deployer", dep.token, encodeFunctionData({ abi: TOKEN_ABI, functionName: "mint", args: [bob, 100_000_000n] }));
  const s = send(meta, deployment);
  await legacy("user1", dep.token, encodeFunctionData({ abi: TOKEN_ABI, functionName: "transfer", args: [s.address, 25_000_000n] }));
  const ann = await legacy(
    "user1",
    dep.announcer,
    encodeFunctionData({ abi: ANNOUNCER_ABI, functionName: "announce", args: [2n, s.address, s.ephemeralPubKey, toHex(new Uint8Array([s.viewTag]))] }),
  );
  check((await balance(dep.token, s.address)) === 25_000_000n, "Bob paid 25 tUSDC to a fresh stealth address", s.address);

  // 3. Alice scans the announcements and finds exactly one payment
  const logs = await pub.getLogs({ address: dep.announcer, event: ANNOUNCEMENT, fromBlock: ann.blockNumber - 50n, toBlock: "latest" });
  const found = logs
    .map((l) => ({ addr: l.args.stealthAddress!, hit: scan(dk, sk, deployment, { stealthAddress: l.args.stealthAddress!, ephemeralPubKey: l.args.ephemeralPubKey!, metadata: l.args.metadata! }) }))
    .filter((x) => x.hit);
  check(found.length === 1 && found[0]!.addr.toLowerCase() === s.address.toLowerCase(), "Alice's scan finds exactly her payment", `${logs.length} announcement(s) scanned`);
  const opener = found[0]!.hit!.opener;
  const stealth = s.address;

  // 4. a sponsor deploys the stealth account (see the Task 7 ruling: no deploy frame)
  const c = commitment(sk, opener);
  // creating ~7 KB of account code pays EIP-8037 state gas on this devnet: give it room
  const deployed = await legacy("relayer", dep.factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: "deploy", args: [c] }), 40_000_000n);
  console.log(`      sponsor deploy used ${deployed.gasUsed} gas`);
  const code = await pub.getCode({ address: stealth });
  check(!!code && code !== "0x", "sponsor deployed the stealth account at the derived address", stealth);

  // 5. Alice approves a transfer with 2 of her 3 hash-only keys and spends through the paymaster
  const destination = privateKeyToAccount(generatePrivateKey()).address;
  const fee = 500_000n;
  const head = await pub.getBlock();
  const approval: TransferApproval = {
    nonce: 0n,
    token: dep.token,
    to: destination,
    amount: 25_000_000n - fee,
    maxFee: 1_000_000n,
    validUntil: head.timestamp + 3600n,
  };
  const digest = transferApprovalDigest(chain.id, stealth, approval);
  const noPersistence = () => {}; // in-process test approvers; real approvers persist (see device-signer.ts)
  const a0 = await browser!.approve(digest, noPersistence);
  const a1 = await device!.approve(digest, noPersistence);
  const auth = {
    threshold: 2n,
    ids,
    opener,
    approval: { ...approval, validUntil: approval.validUntil },
    signerIdx: [0n, 1n],
    envelopes: [a0.envelope, a1.envelope],
    fee,
  };
  const transfer = (to: Address, amount: bigint) =>
    encodeFunctionData({ abi: TOKEN_ABI, functionName: "transfer", args: [to, amount] });
  // [only_verify, pay (verifies the quorum), commit (records the keys), checkDeadline (atomic), transfer (atomic), fee]
  const ATOMIC_BATCH = 0x04;
  const idHashes = [ids[0]!, ids[1]!].map((id) =>
    keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [id.root, id.pubSeed])),
  );
  const leaves = [BigInt(a0.leaf), BigInt(a1.leaf)];
  const frames = [
    ftx.frame(profile, "VERIFY", { target: null, scope: "EXECUTION", execution: 90_000n, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "verifyExecution" }) }),
    ftx.frame(profile, "VERIFY", { target: dep.paymaster, scope: "PAYMENT", execution: 990_000n, data: encodeFunctionData({ abi: PM_ABI, functionName: "approvePayment", args: [auth] }) }),
    ftx.frame(profile, "DEFAULT", { target: dep.paymaster, execution: 120_000n, state: 300_000n, data: encodeFunctionData({ abi: PM_ABI, functionName: "commit", args: [idHashes, leaves] }) }),
    ftx.frame(profile, "DEFAULT", { target: dep.paymaster, flags: ATOMIC_BATCH, execution: 60_000n, data: encodeFunctionData({ abi: PM_ABI, functionName: "checkDeadline", args: [approval.validUntil] }) }),
    ftx.frame(profile, "SENDER", { target: dep.token, flags: ATOMIC_BATCH, execution: 80_000n, state: 200_000n, data: transfer(destination, approval.amount) }),
    ftx.frame(profile, "SENDER", { target: dep.token, execution: 80_000n, state: 200_000n, data: transfer(dep.paymaster, fee) }),
  ];
  const nonce = BigInt(await rpc(rpcUrl, "eth_getTransactionCount", [stealth, "latest"]));
  const tx = ftx.newTx({ chainId: chain.id, sender: stealth, nonceSeq: nonce, frames, signatures: [], fees: { maxFeePerGas: MAX_FEE_PER_GAS } });
  const pmEthBefore = await pub.getBalance({ address: dep.paymaster });
  let hash: Hex;
  try {
    hash = await rpc(sidecarUrl, "eth_sendFrameTransaction", [toWire(tx)]);
  } catch (e) {
    check(false, "the alt mempool sidecar admits the frame tx", e instanceof Error ? e.message.slice(0, 600) : String(e));
    return;
  }
  check(true, "the alt mempool sidecar admits the frame tx", hash);

  // 6. mined: the destination got the money, the paymaster got its fee and paid the gas
  let receipt: any = null;
  for (let i = 0; i < 60 && !receipt; i++) {
    receipt = await rpc(rpcUrl, "eth_getTransactionReceipt", [hash]);
    if (!receipt) await new Promise((r) => setTimeout(r, 2000));
  }
  const frameStatuses = (receipt?.frameReceipts ?? []).map((f: any) => f.status).join(",");
  console.log(`      frame gas used: ${(receipt?.frameReceipts ?? []).map((f: any) => Number(f.gasUsed)).join(", ")}`);
  check(receipt?.status === "0x1" && (receipt.frameReceipts ?? []).every((f: any) => f.status === "0x1"), "the frame tx is mined and every frame succeeded", `block ${Number(receipt?.blockNumber)}, gasUsed ${Number(receipt?.gasUsed)}, frames [${frameStatuses}]`);
  const [dst, pmTok, left] = await Promise.all([balance(dep.token, destination), balance(dep.token, dep.paymaster), balance(dep.token, stealth)]);
  check(dst === approval.amount && left === 0n, "destination received the transfer and the stealth account is empty", `${formatUnits(dst, 6)} tUSDC`);
  check(pmTok >= fee, "paymaster received its fee in tUSDC", formatUnits(pmTok, 6));
  const pmEthAfter = await pub.getBalance({ address: dep.paymaster });
  check(pmEthAfter < pmEthBefore, "paymaster paid the gas in ETH", `${formatEther(pmEthBefore - pmEthAfter)} ETH`);

  // 7. the same approvals again, in a new tx, are refused: the one-time keys are spent
  const replay = ftx.newTx({ chainId: chain.id, sender: stealth, nonceSeq: nonce + 1n, frames, signatures: [], fees: { maxFeePerGas: MAX_FEE_PER_GAS } });
  let replayRejected = false;
  let reason = "";
  try {
    await rpc(sidecarUrl, "eth_sendFrameTransaction", [toWire(replay)]);
  } catch (e) {
    replayRejected = true;
    reason = e instanceof Error ? e.message.slice(0, 200) : String(e);
  }
  // Rejected(4): the paymaster's register already holds these one-time keys
  const KEYS_USED = `0x94064f91${(4).toString(16).padStart(64, "0")}`;
  check(replayRejected && reason.includes(KEYS_USED), "replaying the same approvals is rejected: keys already used", reason);
  console.log(`\nspend tx ${hash}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
