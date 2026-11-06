// Software stand-in for the Firefly device approver. It runs as its own process with its own seed
// and used-key record, shows what it is asked to approve, and signs only after a typed "y".
// It is software, and says so: the real device approver is the Firefly sub-project.
//
//   bun scripts/device-signer.ts [--dir <dataDir>] init
//   bun scripts/device-signer.ts [--dir <dataDir>] identity
//   bun scripts/device-signer.ts [--dir <dataDir>] sign '<{"chainId":…,"account":…,"approval":{…}}>'
//   bun scripts/device-signer.ts [--dir <dataDir>] [--port 8790] serve
//
// `serve` is the bridge for the browser app: GET /identity, and POST /sign with the same JSON as
// `sign`. Each request is shown here and needs a typed "y"; only the app's origin may ask
// (scripts/localOrigin.ts), and it listens on 127.0.0.1 only.
//
// Human-readable text goes to stderr; the machine-readable result is the last line on stdout.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { Approver } from "../src/approver";
import { describeSignRequest, parseSignRequest, type SignRequest } from "../src/signRequest";
import { transferApprovalDigest } from "../src/transferApproval";
import { originAllowed } from "./localOrigin";

const LABEL = "software approver (stand-in for the Firefly device)";

function parseArgs(argv: string[]) {
  const args = [...argv];
  let dir = join(import.meta.dir, "../.device-signer");
  let port = 8790;
  const i = args.indexOf("--dir");
  if (i >= 0) {
    dir = args[i + 1] ?? dir;
    args.splice(i, 2);
  }
  const j = args.indexOf("--port");
  if (j >= 0) {
    port = Number(args[j + 1]);
    args.splice(j, 2);
  }
  return { dir, port, command: args[0], payload: args[1] };
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

function prompt(req: SignRequest): string {
  return [
    `${LABEL}: approval request`,
    ...describeSignRequest(req).map(([label, value]) => `  ${label.padEnd(12)}${value}`),
    `Type y to approve, anything else to refuse:`,
  ].join("\n");
}

/** Signs `req` after the record of the used key is on disk. */
async function signApproved(dir: string, req: SignRequest) {
  const approver = loadApprover(dir);
  const digest = transferApprovalDigest(req.chainId, req.account, req.approval);
  const { leaf, envelope } = await approver.approve(digest, (used) => saveUsed(dir, used));
  console.error(`signed with one-time key ${leaf} (${approver.remaining()} left)`);
  return { leaf, envelope, identity: approver.identity };
}

function serve(dir: string, port: number) {
  loadApprover(dir); // fail now, not on the first request, if there is no seed
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  createInterface({ input: process.stdin }).on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line.trim());
    else lines.push(line.trim());
  });
  const nextLine = () => new Promise<string>((resolve) => (lines.length ? resolve(lines.shift()!) : waiters.push(resolve)));
  let busy = false;
  const json = (body: unknown, status = 200) => Response.json(body, { status });

  Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
      if (!originAllowed(request.method, request.headers.get("origin"))) return json({ error: "origin not allowed" }, 403);
      if (request.method === "GET" && path === "/identity") return json(loadApprover(dir).identity);
      if (request.method === "POST" && path === "/sign") {
        let req: SignRequest;
        try {
          req = parseSignRequest(await request.json());
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "bad request" }, 400);
        }
        if (busy) return json({ error: "busy" }, 409);
        busy = true;
        try {
          lines.length = 0; // only an answer typed after this prompt counts
          console.error(prompt(req));
          if ((await nextLine()) !== "y") {
            console.error("refused: nothing was signed");
            return json({ error: "refused" }, 403);
          }
          return json(await signApproved(dir, req));
        } finally {
          busy = false;
        }
      }
      return json({ error: `no route for ${request.method} ${path}` }, 404);
    },
  });
  console.error(`${LABEL}: listening on http://127.0.0.1:${port} (identity, sign)`);
}

async function main() {
  const { dir, port, command, payload } = parseArgs(process.argv.slice(2));
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
    const req = parseSignRequest(JSON.parse(payload));
    console.error(prompt(req));
    if ((await readAnswer()) !== "y") {
      console.error("refused: nothing was signed");
      process.exit(2);
    }
    console.log(JSON.stringify(await signApproved(dir, req)));
    return;
  }
  if (command === "serve") {
    serve(dir, port);
    return;
  }
  throw new Error(`unknown command ${command}; use init, identity, sign or serve`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
