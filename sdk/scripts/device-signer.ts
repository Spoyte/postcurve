// Software stand-in for the Firefly device approver. It runs as its own process with its own seed
// and used-key record, shows what it is asked to approve, and signs only after a typed "y".
// It is software, and says so: the real device approver is the Firefly sub-project.
//
//   bun scripts/device-signer.ts [--dir <dataDir>] init
//   bun scripts/device-signer.ts [--dir <dataDir>] identity
//   bun scripts/device-signer.ts [--dir <dataDir>] sign '<{"chainId":…,"account":…,"approval":{…}}>'
//
// Human-readable text goes to stderr; the machine-readable result is the last line on stdout.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { bytesToHex, formatUnits, hexToBytes, type Address, type Hex } from "viem";
import { Approver } from "../src/approver";
import { transferApprovalDigest } from "../src/transferApproval";

const LABEL = "software approver (stand-in for the Firefly device)";

function parseArgs(argv: string[]) {
  const args = [...argv];
  let dir = join(import.meta.dir, "../.device-signer");
  const i = args.indexOf("--dir");
  if (i >= 0) {
    dir = args[i + 1] ?? dir;
    args.splice(i, 2);
  }
  return { dir, command: args[0], payload: args[1] };
}

const seedPath = (dir: string) => join(dir, "seed.json");
const usedPath = (dir: string) => join(dir, "used-leaves.json");

function loadApprover(dir: string): Approver {
  const { seed } = JSON.parse(readFileSync(seedPath(dir), "utf8")) as { seed: Hex };
  const used = JSON.parse(readFileSync(usedPath(dir), "utf8")) as number[];
  return Approver.fromSeed(hexToBytes(seed), used);
}

function saveUsed(dir: string, used: number[]) {
  const tmp = `${usedPath(dir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(used), { mode: 0o600 });
  renameSync(tmp, usedPath(dir));
}

async function readAnswer(): Promise<string> {
  for await (const line of console) return line.trim();
  return "";
}

async function main() {
  const { dir, command, payload } = parseArgs(process.argv.slice(2));
  if (command === "init") {
    if (existsSync(seedPath(dir))) throw new Error(`${seedPath(dir)} already exists; refusing to overwrite a seed`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(seedPath(dir), JSON.stringify({ seed: bytesToHex(randomBytes(32)) }), { mode: 0o600 });
    saveUsed(dir, []);
    console.error(`${LABEL}: new seed written to ${seedPath(dir)}`);
    return;
  }
  if (command === "identity") {
    console.log(JSON.stringify(loadApprover(dir).identity));
    return;
  }
  if (command === "sign") {
    if (!payload) throw new Error("sign needs a JSON request argument");
    const req = JSON.parse(payload) as {
      chainId: number;
      account: Address;
      approval: Record<"nonce" | "amount" | "maxFee" | "validUntil", string> & { token: Address; to: Address };
    };
    const a = req.approval;
    const approval = {
      nonce: BigInt(a.nonce),
      token: a.token,
      to: a.to,
      amount: BigInt(a.amount),
      maxFee: BigInt(a.maxFee),
      validUntil: BigInt(a.validUntil),
    };
    console.error(
      [
        `${LABEL}: approval request`,
        `  chain       ${req.chainId}`,
        `  from        ${req.account} (stealth account)`,
        `  token       ${a.token}`,
        `  pay         ${formatUnits(approval.amount, 6)} to ${a.to}`,
        `  fee at most ${formatUnits(approval.maxFee, 6)}`,
        `  valid until ${new Date(Number(approval.validUntil) * 1000).toISOString()}`,
        `Type y to approve, anything else to refuse:`,
      ].join("\n"),
    );
    if ((await readAnswer()) !== "y") {
      console.error("refused: nothing was signed");
      process.exit(2);
    }
    const approver = loadApprover(dir);
    const digest = transferApprovalDigest(req.chainId, req.account, approval);
    const { leaf, envelope } = await approver.approve(digest, (used) => saveUsed(dir, used));
    console.error(`signed with one-time key ${leaf} (${approver.remaining()} left)`);
    console.log(JSON.stringify({ leaf, envelope, identity: approver.identity }));
    return;
  }
  throw new Error(`unknown command ${command}; use init, identity or sign`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
