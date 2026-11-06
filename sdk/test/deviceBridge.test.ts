// The device signer's HTTP bridge for the browser app: only the app may ask, a typed "y" is still
// required, and nothing is signed or recorded for a request that is refused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ORIGINS, originAllowed } from "../scripts/localOrigin";
import { parseSignRequest } from "../src/signRequest";
import { verifyEnvelope } from "../src/xmss";
import { transferApprovalDigest } from "../src/transferApproval";

const SCRIPT = join(import.meta.dir, "../scripts/device-signer.ts");
const APP = "http://localhost:5173";
const EVIL = "https://evil.example";
const request = {
  chainId: 1337,
  account: "0x00000000000000000000000000000000000000b0",
  approval: {
    nonce: "0",
    token: "0x0000000000000000000000000000000000000c0c",
    to: "0x8943545177806ED17B9F23F0a21ee5948eCaa776",
    amount: "24000000",
    maxFee: "1000000",
    validUntil: "2000000000",
  },
};

describe("originAllowed", () => {
  test("app origins only, for writes", () => {
    expect(APP_ORIGINS).toEqual(["http://localhost:5173", "http://127.0.0.1:5173"]);
    expect(originAllowed("POST", EVIL)).toBe(false);
    expect(originAllowed("POST", null)).toBe(false);
    expect(originAllowed("POST", APP)).toBe(true);
    expect(originAllowed("POST", "http://127.0.0.1:5173")).toBe(true);
  });

  test("a GET without Origin is allowed, a GET from a foreign page is not", () => {
    expect(originAllowed("GET", null)).toBe(true);
    expect(originAllowed("GET", EVIL)).toBe(false);
  });

  test("extra origins come from POSTCURVE_APP_ORIGINS", () => {
    const before = process.env.POSTCURVE_APP_ORIGINS;
    process.env.POSTCURVE_APP_ORIGINS = "https://demo.trycloudflare.com, https://other.example";
    try {
      expect(originAllowed("POST", "https://demo.trycloudflare.com")).toBe(true);
      expect(originAllowed("POST", "https://other.example")).toBe(true);
      expect(originAllowed("POST", EVIL)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.POSTCURVE_APP_ORIGINS;
      else process.env.POSTCURVE_APP_ORIGINS = before;
    }
  });
});

describe("parseSignRequest", () => {
  test("accepts the e2e-shaped request", () => {
    const r = parseSignRequest(request);
    expect(r.chainId).toBe(1337);
    expect(r.approval.amount).toBe(24_000_000n);
    expect(r.approval.validUntil).toBe(2_000_000_000n);
  });

  test("rejects a missing destination, a non-numeric amount and a string chain id", () => {
    const noTo = structuredClone(request) as any;
    delete noTo.approval.to;
    expect(() => parseSignRequest(noTo)).toThrow();
    const badAmount = structuredClone(request) as any;
    badAmount.approval.amount = "24e6";
    expect(() => parseSignRequest(badAmount)).toThrow();
    const stringChain = structuredClone(request) as any;
    stringChain.chainId = "1337";
    expect(() => parseSignRequest(stringChain)).toThrow();
    expect(() => parseSignRequest(null)).toThrow();
  });
});

describe("device signer serve", () => {
  let dir: string;
  let proc: ReturnType<typeof Bun.spawn>;
  let url: string;
  let stderr = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "postcurve-bridge-"));
    expect(Bun.spawnSync(["bun", SCRIPT, "--dir", dir, "init"]).exitCode).toBe(0);
    const port = 20000 + Math.floor(Math.random() * 20000);
    url = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", SCRIPT, "--dir", dir, "--port", String(port), "serve"], { stdin: "pipe", stderr: "pipe" });
    (async () => {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) stderr += new TextDecoder().decode(chunk);
    })();
    for (let i = 0; i < 100 && !stderr.includes("listening"); i++) await Bun.sleep(50);
    expect(stderr).toContain("listening");
  });

  afterAll(() => proc?.kill());

  const used = () => JSON.parse(readFileSync(join(dir, "used-leaves.json"), "utf8"));
  const post = (origin: string | null, body: unknown) =>
    fetch(`${url}/sign`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });

  test("rejects a foreign origin: 403, nothing signed or recorded", async () => {
    const r = await post(EVIL, request);
    expect(r.status).toBe(403);
    expect(used()).toEqual([]);
  });

  test("a malformed request is 400", async () => {
    const r = await post(APP, { chainId: 1337 });
    expect(r.status).toBe(400);
  });

  test("GET /identity answers the device's public identity", async () => {
    const r = await fetch(`${url}/identity`);
    expect(r.status).toBe(200);
    const id = await r.json();
    expect(id.root).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("answering y in the terminal signs; a second request meanwhile is busy", async () => {
    const pending = post(APP, request);
    for (let i = 0; i < 100 && !stderr.includes("Type y"); i++) await Bun.sleep(50);
    expect(stderr).toContain("pay         24 to 0x8943545177806ED17B9F23F0a21ee5948eCaa776");
    const busy = await post(APP, request);
    expect(busy.status).toBe(409);
    (proc.stdin as any).write("y\n");
    (proc.stdin as any).flush?.();
    const r = await pending;
    expect(r.status).toBe(200);
    const { leaf, envelope, identity } = await r.json();
    expect(leaf).toBe(0);
    const a = request.approval;
    const digest = transferApprovalDigest(request.chainId, request.account as `0x${string}`, {
      nonce: 0n,
      token: a.token as `0x${string}`,
      to: a.to as `0x${string}`,
      amount: 24_000_000n,
      maxFee: 1_000_000n,
      validUntil: 2_000_000_000n,
    });
    expect(verifyEnvelope(identity, digest, envelope)).toBe(0);
    expect(used()).toEqual([0]);
  });

  test("answering n refuses with 403 and records nothing new", async () => {
    const before = stderr.length;
    const pending = post(APP, request);
    for (let i = 0; i < 100 && !stderr.slice(before).includes("Type y"); i++) await Bun.sleep(50);
    (proc.stdin as any).write("n\n");
    (proc.stdin as any).flush?.();
    const r = await pending;
    expect(r.status).toBe(403);
    expect(used()).toEqual([0]);
  });
});
