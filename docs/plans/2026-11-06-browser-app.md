# Browser App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser app in the "Bunker" look that runs the whole postcurve flow against the local
devnet (Setup, Receive, Pay, Payments, Spend, Keys, Canary, then Check), with real transactions
and nothing faked.

**Architecture:** `app/` is a Vite + React + TypeScript single-page app that imports the SDK from
`../sdk/src` and reaches every local service through the Vite dev-server proxy (one origin). A
small Bun "operator" service holds devnet keys for the sponsor deploy and Bob's faucet; the
device approver's software stand-in gets an HTTP `serve` mode and prompts in its own terminal.
The six-frame spend transaction moves from `e2e-stealth.ts` into the SDK so the script and the
app build the exact same transaction.

**Tech Stack:** Bun 1.4.4, TypeScript, React 19, Vite 7, viem 2, `qrcode`, `@forshtat/hegota-support`
0.0.1 (`/tx`, `/rpc`, `/profiles`), Playwright (Chromium is already installed in `~/.cache/ms-playwright`).

**Spec:** [docs/ui-design.md](../ui-design.md), under [docs/design.md](../design.md) (its
anti-goals apply). Brainstorm mockups (local only): `.superpowers/brainstorm/*/content/style.html`
(Bunker card) and `screens.html`.

## Global Constraints

- Local devnet only: chain 1337, RPC `http://127.0.0.1:18545`, sidecar `http://127.0.0.1:14337/rpc`,
  deployment in `devnet/data/stealth-deployment.json`, funded keys in `devnet/data/keys/accounts.json`
  read only through `devnetKey(name)` from `sdk/scripts/deploy-stealth.ts`, never printed or sent to a browser.
- Ports: Vite `5173` (strictPort), canary service `8787`, device bridge `8790`, operator `8791`.
  App origins: `http://localhost:5173`, `http://127.0.0.1:5173`.
- Proxy: `/rpc` → `127.0.0.1:18545`, `/sidecar` → `127.0.0.1:14337/rpc`, `/canary` → `127.0.0.1:8787`,
  `/device` → `127.0.0.1:8790`, `/operator` → `127.0.0.1:8791` (prefix stripped).
- Extra app origins (the public tunnel URL) come from `POSTCURVE_APP_ORIGINS` (comma-separated), read by
  every local service at start.
- Local services bind `127.0.0.1`. A `POST` whose `Origin` is not an app origin gets 403; a `GET`
  with a foreign `Origin` gets 403; a `GET` with no `Origin` is allowed (browsers omit it on
  same-origin GETs) and only ever returns public data.
- Bunker palette: background `#0b0f14`, sidebar `#0e131a`, panels `#121821`, borders `#1e2733`,
  text `#d7dee8`, muted `#7d8898`, mint `#5eead4`, amber `#f5b14c`, red `#f87171` on `#3b1418`.
  System sans-serif; monospace for addresses, amounts and gas. No external fonts, CDNs or trackers.
- Labels, verbatim wherever the thing appears: "Device (software stand-in)", "tUSDC · test token",
  "Bob · ordinary ECDSA test account", "local devnet", "postcurve operator".
- Spend values: fee `500000` (0.50 tUSDC), max fee `1000000` (1.00), `validUntil` = head
  timestamp + 3600, `maxFeePerGas` 2 gwei, approval nonce 0. Pay minimum 1.00 tUSDC. Spend
  disabled when balance ≤ max fee.
- Nothing faked: no simulated transactions, refusals or alerts. A browser key is recorded as used
  in storage before its signature exists. The paper seed is never stored.
- Commits: small Conventional Commits as Spoyte, pushed after each task. Nothing mentions the
  user's employer; no AI attribution. Keep README current.

**Execution order** (decided 2026-11-07 with the author: a public URL through a Cloudflare Tunnel
from the laptop, with a phone approver for visitors): Tasks 1–9, then 12, 13, 11, 10.

## Review Focus

1. **Refresh or crash between reserving a key and signing.** The leaf must stay used after a
   reload and never sign a second digest. Pinned in Task 4 (`approve persists before signing`).
2. **A foreign web page calls the device bridge or the operator.** Must get 403 with nothing
   signed or sent. Pinned in Tasks 2 and 3 (`rejects a foreign origin`).
3. **A truncated or edited payment link.** Bad base64, wrong length or a wrong version byte must
   show "not a valid postcurve payment link" and never pay. Pinned in Task 5 (`decodePayLink rejects`).
4. **The devnet is redeployed under a running app.** Payments and spends clear; keys, identities,
   meta-address and used-key lists stay. Pinned in Task 3 (`redeploy keeps used keys`).
5. **The device refuses or the bridge is down mid-spend.** No transaction is sent, the browser's
   leaf stays used and shows as "used locally, never landed". Pinned in Tasks 7 and 8.

---

## File Structure

```
sdk/src/stealth/spendTx.ts        shared six-frame spend transaction (Task 1)
sdk/test/stealth/spendTx.test.ts
sdk/scripts/e2e-stealth.ts        uses spendTx (Task 1)
sdk/scripts/device-signer.ts      + serve mode (Task 2)
sdk/scripts/localOrigin.ts        Origin rule shared by bridge and operator (Task 2)
sdk/test/deviceBridge.test.ts
app/package.json, vite.config.ts, tsconfig.json, index.html, dev.ts
app/operator.ts                   /config, /deploy, /faucet (Task 3)
app/src/main.tsx, App.tsx, theme.css, components/{Sidebar,AlertBar,KeyGrid,FrameList,Panel}.tsx
app/src/lib/{config,chain,store,keys,keys.worker,link,payments,spend,keyGrid,alerts,exposure}.ts
app/src/screens/{Setup,Receive,Pay,Payments,Spend,Keys,Canary,Check}.tsx
app/test/*.test.ts                bun test, pure logic only
app/e2e/flow.spec.ts              Playwright run of the whole flow (Task 10)
```

## Shared types (defined once, used by the tasks named)

```ts
// app/src/lib/config.ts (Task 3) — GET /operator/config
type AppConfig = {
  chainId: number;
  deployment: StealthDeployment;            // sdk/scripts/deploy-stealth.ts type
  accountCreationCode: Hex;                 // contracts/out StealthBunkerAccount bytecode
  abi: { token: Abi; paymaster: Abi; account: Abi; factory: Abi; announcer: Abi };
};
// app/src/lib/store.ts (Task 3), localStorage key "postcurve/v1"
type Stored = {
  deploymentId: string;                     // `${chainId}:${paymaster.toLowerCase()}`
  browser?: { seed: Hex; used: number[] };
  identities?: { browser: Identity; device: Identity; paper: Identity };
  meta?: { threshold: 2; spendKey: Hex; metaAddress: Hex; ek: Hex; dk: Hex };
  payments: Payment[];                      // Task 6
  spends: SpendRecord[];                    // Task 7
  seenAlerts: string[];                     // Task 9
  redeployed?: true;                        // set by readStore only, never written
};
type Payment = { stealth: Address; opener: Hex; block: number; amount: string /* base units */ };
type SpendRecord = {
  stealth: Address; to: Address; amount: string; fee: string; validUntil: string;
  signers: { idx: 0 | 1 | 2; leaf: number; envelope: Hex }[];
  txHash?: Hex; status: "signed" | "submitted" | "mined" | "failed"; error?: string;
};
```

---

### Task 1: The spend transaction lives in the SDK

**Files:**
- Create: `sdk/src/stealth/spendTx.ts`, `sdk/test/stealth/spendTx.test.ts`
- Modify: `sdk/src/stealth/index.ts` (export), `sdk/scripts/e2e-stealth.ts` (use it; behaviour unchanged)

**Interfaces:**
- Produces:
  - `SPEND_FEE = 500_000n`, `SPEND_MAX_FEE = 1_000_000n`, `MAX_FEE_PER_GAS = 2_000_000_000n`, `ATOMIC_BATCH = 0x04`
  - `identityHash(id: Identity): Hex` = `keccak256(abi.encode(bytes32 root, bytes32 pubSeed))`
  - `type SpendParams = { stealth: Address; paymaster: Address; token: Address; threshold: bigint; ids: Identity[]; opener: Hex; approval: TransferApproval; fee: bigint; signers: { idx: number; leaf: number; envelope: Hex }[] }`
  - `buildSpendFrames(p: SpendParams, abi: { paymaster: Abi; account: Abi; token: Abi }): Frame[]` — the six frames exactly as `e2e-stealth.ts` builds them after the stealth-core fix pass: `[only_verify, pay, commit (burns the keys, not atomic), checkDeadline (atomic), transfer (atomic), fee]`, with the same modes, targets, flags and limits
  - `buildSpendTx(chainId: number, stealth: Address, nonce: bigint, frames: Frame[])` → `ftx.newTx(...)` with `MAX_FEE_PER_GAS` and the `ethrex-eip8141-tracer` profile

- [ ] **Step 1: Write the failing test** `spendTx.test.ts`: build params from two `Approver.fromSeed` approvals over a fixed digest and assert
  - `frames.length === 6`; modes `VERIFY, VERIFY, DEFAULT, DEFAULT, SENDER, SENDER` and targets `null, paymaster, paymaster, paymaster, token, token` (read them back through the hegota frame fields);
  - frame 2 (commit) data `=== encodeFunctionData(commit, [[identityHash(ids[0]), identityHash(ids[1])], [leaf0, leaf1]])` without the atomic flag; frame 3 (checkDeadline) data encodes `validUntil` and frames 3 and 4 carry the atomic flag; frame 5 (fee) does not;
  - `identityHash` of a known identity equals the Solidity value from `contracts/test` (copy one from a Foundry test or compute with `cast abi-encode` + `cast keccak` and paste the constant).
- [ ] **Step 2: Run** `cd sdk && bun test test/stealth/spendTx.test.ts` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `spendTx.ts`, then replace the inline frame building in `e2e-stealth.ts` with `buildSpendFrames` / `buildSpendTx` (the replay in step 7 of the script uses `buildSpendTx(..., nonce + 1n, frames)`).
- [ ] **Step 4: Run** `cd sdk && bun test` — Expected: all pass (84 + new). Then, devnet up: `cd sdk && bun scripts/e2e-stealth.ts` — Expected: `PASS 11.` and a spend tx hash.
- [ ] **Step 5: Commit** `refactor(sdk): share the six-frame spend transaction between the e2e script and the app`.

### Task 2: Device bridge (`device-signer.ts serve`)

**Files:**
- Create: `sdk/scripts/localOrigin.ts`, `sdk/test/deviceBridge.test.ts`
- Modify: `sdk/scripts/device-signer.ts` (add `serve [--port 8790]`; `init`, `identity`, `sign` unchanged)

**Interfaces:**
- Produces:
  - `APP_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]`
  - `originAllowed(method: string, origin: string | null): boolean` — the Global Constraints rule
  - `parseSignRequest(body: unknown): { chainId: number; account: Address; approval: TransferApproval }` — throws on any missing or malformed field (same JSON as `sign`: bigint fields as decimal strings)
  - HTTP: `GET /identity` → `Identity`; `POST /sign` → `200 {leaf, envelope, identity}` | `403 {error:"refused"}` | `409 {error:"busy"}` while a prompt is open | `400` on a bad request
- The terminal prompt is the existing `sign` text (chain, stealth account, token, pay amount to, fee at most, valid until, "Type y to approve"). The digest is computed here with `transferApprovalDigest`; a digest in the request is ignored. Read answers with one shared `readline` interface on stdin.

- [ ] **Step 1: Write the failing tests**: `originAllowed("POST", "https://evil.example") === false`; `originAllowed("POST", null) === false`; `originAllowed("POST", "http://localhost:5173") === true`; `originAllowed("GET", null) === true`; `originAllowed("GET", "https://evil.example") === false`. `parseSignRequest` rejects a missing `approval.to`, a non-numeric `amount`, and a `chainId` string; accepts the e2e-shaped request. **`rejects a foreign origin`**: start `serve` on a random port as a subprocess with a temp `--dir` (after `init`), `POST /sign` with `Origin: https://evil.example` → 403, and the used-leaves file is still `[]`.
- [ ] **Step 2: Run** `cd sdk && bun test test/deviceBridge.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `localOrigin.ts` and the `serve` command (Bun.serve on `127.0.0.1`).
- [ ] **Step 4: Run** the test file, then the whole `bun test` — Expected: PASS. Manual: `bun scripts/device-signer.ts --dir /tmp/x init && bun scripts/device-signer.ts --dir /tmp/x serve`, then `curl -s -X POST -H 'Origin: http://localhost:5173' --data '<e2e request>' 127.0.0.1:8790/sign`, type `y` in the bridge terminal — Expected: JSON with `leaf: 0`.
- [ ] **Step 5: Commit** `feat(sdk): device signer serve mode for the browser app`.

### Task 3: App shell, operator service and storage

**Files:**
- Create: `app/package.json`, `app/vite.config.ts`, `app/tsconfig.json`, `app/index.html`, `app/dev.ts`, `app/operator.ts`, `app/src/{main.tsx,App.tsx,theme.css}`, `app/src/components/{Sidebar,Panel}.tsx`, `app/src/lib/{config,chain,store}.ts`, `app/test/{operator,store}.test.ts`
- Modify: `.gitignore` (`app/node_modules`, `app/dist`, `app/e2e/screens`), `README.md` (a "Run the app" section: devnet up, `deploy-stealth.ts`, canary service, device bridge, `cd app && bun install && bun run dev`)

**Interfaces:**
- Consumes: `originAllowed` (Task 2); `devnetKey`, `artifact`, `DEPLOYMENT_PATH`, `devnetConfig` from `sdk/scripts/deploy-stealth.ts`.
- Produces:
  - Operator HTTP on `127.0.0.1:8791`: `GET /config` → `AppConfig`; `POST /deploy {commitment}` → `{address, txHash}` (factory `deploy`, gas 40,000,000, key `relayer`; if code already exists, returns `{address, txHash: null}`); `POST /faucet {address}` → `{ethTx, mintTx}` (0.05 ETH from `faucet`, `mint(address, 100_000_000)` from `deployer`). One transaction at a time per key (a promise queue), legacy txs at 2× gas price as in `e2e-stealth.ts`.
  - `loadConfig(): Promise<AppConfig>` (fetch `/operator/config`, cached)
  - `publicClient(cfg)` (viem, `http("/rpc", { batch: { batchSize: 128 } })`), `sidecarRpc(method, params)` (hegota `rpc("/sidecar", ...)`)
  - `readStore(deploymentId: string): Stored` — a missing or unparsable entry gives an empty `Stored`; a different `deploymentId` returns the stored keys, identities, meta and `seenAlerts` with `payments: []` and `spends: []` and sets `redeployed: true` on the result (one-shot flag for the banner)
  - `writeStore(s: Stored): void` (synchronous `localStorage.setItem`), `resetAll(): void`
  - Shell: hash routes `#/setup #/check #/receive #/pay #/payments #/spend/:stealth #/keys #/canary`; `Sidebar` (wordmark, Check, Receive, Payments, Keys, Canary with an unread count slot, and a small "Reset demo" at the bottom that asks to confirm, then `resetAll()`); until setup is complete every Alice route renders Setup; `#/pay` never shows the sidebar. When `readStore` reports `redeployed`, a one-time amber banner says "The devnet was redeployed: old payments were cleared. Your keys are unchanged."
- Vite: `resolve.alias { "@postcurve/sdk": "../sdk/src/index.ts" }`, the proxy table, `server.fs.allow: [".."]`, port 5173 strictPort. `app/tsconfig.json` mirrors the alias in `paths` so `bun test` resolves it. `dev.ts` spawns `bun operator.ts` and `bunx vite`, prefixes their output, and kills both on exit.

- [ ] **Step 1: Write the failing tests.** `operator.test.ts` (pure handler, no chain): **`rejects a foreign origin`** — `POST /faucet` with `Origin: https://evil.example` → 403 and the send function is never called (inject a fake sender); `POST /deploy` with a commitment that isn't 32 bytes → 400. `store.test.ts` (a `Map`-backed `localStorage` shim): round trip; **`redeploy keeps used keys`** — write a store with `deploymentId "1337:0xaaa"`, browser used `[0,1]`, one payment and one spend, read with `"1337:0xbbb"` → `browser.used` `[0,1]`, identities and meta equal, `payments` and `spends` empty, `redeployed === true`.
- [ ] **Step 2: Run** `cd app && bun test` — Expected: FAIL.
- [ ] **Step 3: Implement** the files above. `theme.css` defines the palette as CSS variables and the base panel, button (mint primary, ghost), tag and monospace styles from the Bunker mockup.
- [ ] **Step 4: Run** `bun test` — Expected: PASS. Then `bun run dev`, open `http://localhost:5173` — Expected: the Bunker shell with the sidebar and an empty Setup screen; `curl -s 127.0.0.1:8791/config | head -c 200` shows the deployment.
- [ ] **Step 5: Commit** `feat(app): app shell, operator service and storage`.

### Task 4: Keys in a worker, and Setup

**Files:**
- Create: `app/src/lib/{keys.ts,keys.worker.ts}`, `app/src/screens/Setup.tsx`, `app/test/keys.test.ts`

**Interfaces:**
- Consumes: SDK `Approver`, `mnemonicFromSeed`, `viewKeyFromSeed`, `spendKey`, `encodeMetaAddress`, `identityOf`/`buildTree`; `readStore`/`writeStore` (Task 3).
- Produces:
  - Worker messages: `{type:"init", seed, used}` → `{type:"ready", identity}`; `{type:"approve", id, digest}` → (worker sends `{type:"save", id, used}`, waits for `{type:"saved", id}` or `{type:"save-failed", id}`) → `{type:"approved", id, leaf, envelope}` | `{type:"error", id, message}`; `{type:"identity", id, seed}` → `{type:"identity", id, identity}` (stateless, for the paper seed). Inside the worker, `approve` calls `Approver.approve(digest, save)` so the SDK's save-before-sign rule is the one in force.
  - `class BrowserKey { static async open(seed: Hex, used: number[], persist: (used: number[]) => void): Promise<BrowserKey>; identity: Identity; approve(digest: Hex): Promise<{leaf: number; envelope: Hex}>; }` — `persist` runs on the main thread (writes the store); if it throws, the worker gets `save-failed` and `approve` rejects.
  - `identityFromSeed(seed: Hex): Promise<Identity>` (worker)
  - Setup steps as in the design: (1) browser key + its 24 words (`mnemonicFromSeed`); (2) "Pair the device": `GET /device/identity`, with the exact command to start the bridge shown if it fails; (3) paper seed: 24 words shown once, a checkbox "I wrote these down" enables Continue, then `identityFromSeed` and `viewKeyFromSeed` run, and the seed variable is dropped; (4) `spendKey(2n, [browser, device, paper])` and `encodeMetaAddress`. Each step shows "preparing your keys" while the worker runs. Order of identities is always browser, device, paper (signer idx 0, 1, 2).

- [ ] **Step 1: Write the failing test** `keys.test.ts` (Bun runs Web Workers): **`approve persists before signing`** — open a `BrowserKey` whose `persist` records calls; after `approve(d)` resolves, `persist` was called once with `[0]` and the returned leaf is 0; a second `approve` returns leaf 1. **`failed save produces no signature`** — `persist` throws → `approve` rejects, and opening a new `BrowserKey` from the last persisted list (empty) after a successful later save still never hands out a leaf that was persisted. `identityFromSeed(seed)` equals `Approver.fromSeed(seed).identity`.
- [ ] **Step 2: Run** `cd app && bun test test/keys.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `keys.worker.ts`, `keys.ts`, `Setup.tsx`.
- [ ] **Step 4: Run** `bun test` — Expected: PASS. Manual with the bridge running: complete Setup in the browser — Expected: lands on Receive; reload stays set up; localStorage has no paper seed (search the stored JSON for the paper words: none).
- [ ] **Step 5: Commit** `feat(app): set up the three approver keys and the meta-address`.

### Task 5: Receive and Pay

**Files:**
- Create: `app/src/lib/link.ts`, `app/src/screens/{Receive,Pay}.tsx`, `app/test/link.test.ts`
- Modify: `app/package.json` (`qrcode`, `@types/qrcode`)

**Interfaces:**
- Consumes: `send` (SDK stealth), `decodeMetaAddress`, `loadConfig`, `publicClient`.
- Produces: `encodePayLink(origin: string, meta: Hex): string` → `${origin}/#/pay?to=<base64url of the 1,217 bytes>`; `decodePayLink(hashOrUrl: string): Hex | null` (null unless it decodes to exactly 1,217 bytes that `decodeMetaAddress` accepts).
- Receive: the link in a monospace box with Copy, a QR (`qrcode` to canvas, error level L), and the line "Every payment to this link lands at a brand-new address that only you can find." Pay (`#/pay`, no sidebar, header "Bob · ordinary ECDSA test account"): a fresh key in `localStorage["postcurve/bob"]`, its ETH and tUSDC balance, "Get test funds" (`POST /operator/faucet`), amount (min 1.00 tUSDC), Pay → `send(meta, deployment)`, check the address has no code and nonce 0, `transfer` then `announce(2, address, ephemeralPubKey, viewTag byte)`, then show "You paid 0x… — an address with no history before this payment".

- [ ] **Step 1: Write the failing test** `link.test.ts`: round trip of a real meta-address (build one with SDK functions); **`decodePayLink rejects`** a link with one character removed, one with `0x03` as the first byte, a non-base64 string, and an empty `to` — all `null`.
- [ ] **Step 2: Run** `bun test test/link.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `link.ts`, `Receive.tsx`, `Pay.tsx`. An invalid link shows "Not a valid postcurve payment link" and no Pay button.
- [ ] **Step 4: Run** `bun test` — Expected: PASS. Manual: open the link in a second window, get funds, pay 25 — Expected: the stealth address holds 25 tUSDC (`cast call` or the Payments screen in Task 6).
- [ ] **Step 5: Commit** `feat(app): private payment link and Bob's pay screen`.

### Task 6: Payments (scan)

**Files:**
- Create: `app/src/lib/payments.ts`, `app/src/screens/Payments.tsx`, `app/test/payments.test.ts`

**Interfaces:**
- Consumes: SDK `scan`, `Announcement`; store; config.
- Produces: `findMine(anns: (Announcement & {block: number})[], dk: Uint8Array, spendKey: Hex, d: Deployment): { stealth: Address; opener: Hex; block: number }[]`; a poller (every 4 s, `getLogs` on the announcer from the last scanned block + 1, starting at 0) that adds new finds to `store.payments` and refreshes balances.
- Screen: "N announcements scanned · M are yours"; one panel per payment: amount (tUSDC · test token), stealth address, status `unspent` / `spent` (balance 0 and a mined spend in the store), a Spend button for unspent payments with balance above the max fee.

- [ ] **Step 1: Write the failing test**: three announcements built with SDK `send` (two to Alice's meta-address, one to another meta-address) plus one with a 10-byte ciphertext → `findMine` returns exactly Alice's two, in block order.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` — Expected: PASS. Manual: after Task 5's payment — Expected: "1 is yours" (singular copy) and the 25.00 tUSDC panel appear within 5 s.
- [ ] **Step 5: Commit** `feat(app): scan announcements and list payments`.

### Task 7: Spend

**Files:**
- Create: `app/src/lib/spend.ts`, `app/src/screens/Spend.tsx`, `app/src/components/FrameList.tsx`, `app/test/spend.test.ts`

**Interfaces:**
- Consumes: `buildSpendFrames`, `buildSpendTx`, `identityHash`, `SPEND_FEE`, `SPEND_MAX_FEE` (Task 1); `BrowserKey` (Task 4); bridge `POST /device/sign` (Task 2); operator `/deploy` (Task 3); `sidecarRpc`.
- Produces: `spendAmounts(balance: bigint): { amount: bigint; fee: bigint } | null` (null when `balance <= SPEND_MAX_FEE`); `runSpend(payment, to, hooks)` that walks the steps `deploy → browser → device → submit → mined`, calling `hooks.onStep(step, detail)`, and writes a `SpendRecord` after each step (status `signed` once both envelopes exist, `submitted` with `txHash`, `mined`, or `failed` with `error`).
- Screen: destination (prefilled with a fresh random address, labelled "a new address of yours"), amount and fee; Approve and spend; the step list (operator deploys the account, browser approves with key #n, "approve in the device terminal" then key #m, sent to the alt mempool, mined in block b); `FrameList` lights each of the six frames from `frameReceipts` with gas used; then the panels "What everyone else sees" (Bob's fresh account paid it; the postcurve operator deployed it; the spend; gas paid by the paymaster; 0 ETH ever held; "This spend links the stealth account to the destination.") and "Keys this spend used" (both key numbers and the browser's `KeyGrid` with the two marked, the new one pulsing once).

- [ ] **Step 1: Write the failing test**: `spendAmounts(25_000_000n)` → `{amount: 24_500_000n, fee: 500_000n}`; `spendAmounts(1_000_000n)` → `null`; **`device refusal sends nothing`** — `runSpend` with a fake bridge that returns 403 and a fake sidecar that records calls → rejects with "refused on the device", the sidecar was never called, and the stored record has `status: "failed"` with the browser's leaf in `signers`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `spend.ts` (dependencies injected: `deploy`, `deviceSign`, `browserApprove`, `submit`, `receipt`), `FrameList.tsx`, `Spend.tsx`.
- [ ] **Step 4: Run** `bun test` — Expected: PASS. Manual on the devnet with the bridge: spend the 25 tUSDC, type `y` in the bridge — Expected: six lit frames, destination holds 24.50 tUSDC, the paymaster's ETH went down.
- [ ] **Step 5: Commit** `feat(app): spend through the paymaster with two hash-only approvals`.

### Task 8: Keys, and the live replay

**Files:**
- Create: `app/src/lib/keyGrid.ts`, `app/src/screens/Keys.tsx`, `app/src/components/KeyGrid.tsx`, `app/test/keyGrid.test.ts`

**Interfaces:**
- Consumes: `identityHash`, paymaster `isLeafUsed`, store (`browser.used`, `spends`), `buildSpendFrames`, `buildSpendTx`, `sidecarRpc`.
- Produces: `type KeyState = "unused" | "onchain" | "local"`; `mergeKeyStates(onchain: boolean[], localUsed: number[]): KeyState[]` (256 entries; `onchain` wins; a locally used leaf not on chain is `"local"`); `explainRefusal(message: string): string` (contains `Rejected(4)` or `Rejected(5)` → "Refused: these one-time keys were already used", otherwise the message as is); `replayLastSpend()` rebuilds the last mined spend's frames from its `SpendRecord` with the account's current nonce and submits it to the sidecar, returning the sidecar's error verbatim plus `explainRefusal`.
- Screen: three `KeyGrid`s (16×16, 256 cells; unused dim, `onchain` marked, `local` amber outline; the next unused browser key glows mint), each with "n used, 256 − n left". Device and paper grids come from the chain only. Reads: all 256 `isLeafUsed` per identity, refreshed on open, after a spend, and every 15 s while open. "Try to reuse a key" is enabled when a mined spend exists, and shows the refusal in a red panel with the raw message underneath.

- [ ] **Step 1: Write the failing test**: `mergeKeyStates` with onchain `[0,1]` true and local `[0,1,2]` → `onchain, onchain, local, unused…` (length 256); `explainRefusal("…Rejected(4)…")` and `"…Rejected(5)…"` give the plain sentence; another message passes through.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` — Expected: PASS. Manual after Task 7's spend: browser and device grids show key 0 as used; "Try to reuse a key" — Expected: the red refusal panel with the sidecar's message.
- [ ] **Step 5: Commit** `feat(app): one-time key grids and a live replay attempt`.

### Task 9: Canary and the alert bar

**Files:**
- Create: `app/src/lib/alerts.ts`, `app/src/screens/Canary.tsx`, `app/src/components/AlertBar.tsx`, `app/test/alerts.test.ts`
- Modify: `app/src/App.tsx` (mount `AlertBar`, unread count in `Sidebar`)

**Interfaces:**
- Consumes: canary service `GET /canary/watchlist`, `GET /canary/alerts` (shapes: `import type` from `canary/workflow/types.ts`), store `seenAlerts`.
- Produces: `unseenAlerts(alerts: Alert[], seen: string[]): Alert[]` (newest first by `raisedAt`); a 5 s poller shared by the bar and the screen; when the service is unreachable the Canary screen says "Canary service not running" with its start command, and the bar stays hidden.
- Screen: watchlist rows (address, label, balance via `formatWeiAsEth`, exposure kind and evidence tx, dormancy); alert cards (severity, address, moved amount, exposure evidence, dormancy, sweep tx). Bar: red, slides in once, "Canary · dormant exposed address 0x… just moved N ETH · block b", dismiss marks it seen.

- [ ] **Step 1: Write the failing test**: three alerts, one seen → two unseen, newest first; empty list → empty.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` — Expected: PASS. Manual: `canary/demo/run-demo.sh --keep-service` — Expected: after its second simulation the bar drops in on whatever screen is open and the Canary screen shows the alert card.
- [ ] **Step 5: Commit** `feat(app): canary watchlist, alert feed and alert bar`.

### Task 10: One scripted run through the whole flow

**Files:**
- Create: `app/e2e/flow.spec.ts`, `app/playwright.config.ts`
- Modify: `app/package.json` (`@playwright/test`, script `e2e`), `README.md` (how to run it; a written run-through for recording the video)

**Interfaces:**
- Consumes: everything above. The test starts the operator + Vite (`webServer: bun run dev`) and the device bridge itself (fresh temp `--dir`, `init`, then `serve` with piped stdin; it writes `y\n` when stdout/stderr shows "Type y"). It assumes the devnet is up and `deploy-stealth.ts` has run.

- [ ] **Step 1: Write the test**: Setup (tick "I wrote these down") → Receive (read the link) → new page on the link → Get test funds → Pay 25 → back on Payments, wait for "is yours" → Spend → wait for six lit frames → Keys → Try to reuse a key → expect "already used". Screenshot each screen to `app/e2e/screens/<n>-<name>.png` at 1440×900.
- [ ] **Step 2: Run** `cd app && bun run e2e` — Expected: PASS, eight screenshots.
- [ ] **Step 3: Commit** `test(app): scripted run of the whole flow against the local devnet`.

### Task 11: Check

**Files:**
- Create: `app/src/lib/exposure.ts`, `app/src/screens/Check.tsx`, `app/test/exposure.test.ts`

**Interfaces:**
- Produces: `type Exposure = { kind: "exposed"; sent: number } | { kind: "contract" } | { kind: "unknown" }`; `classifyExposure(r: { nonce: number; code: Hex | undefined }): Exposure` (code present and not `0x` → contract; nonce > 0 → exposed; else unknown); reads via `VITE_CHECK_RPC_URL` (default `https://ethereum.publicnode.com`).
- Screen: a textarea for addresses (one per line; invalid lines flagged, not sent); per address: "Exposed: has sent N transactions", "Smart account: depends on its signers", or "Never sent a transaction, but exposure can't be ruled out (permits, EIP-7702 authorizations and contract-checked signatures also reveal keys)", with the ETH balance as value at risk; total at risk. A visible amber note names the RPC in use and says it sees the addresses checked (until Anon-RPC is wired). "Move to a bunker" links to Receive.

- [ ] **Step 1: Write the failing test**: `{nonce: 3, code: "0x"}` → exposed 3; `{nonce: 0, code: undefined}` → unknown; `{nonce: 5, code: "0x6080"}` → contract.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` — Expected: PASS. Manual: check `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` — Expected: exposed, with a balance.
- [ ] **Step 5: Commit** `feat(app): exposure check`.

### Task 12: Phone approver (the device stand-in, for visitors)

**Files:**
- Create: `app/src/lib/device.ts`, `app/src/screens/Device.tsx`, `app/relay.ts`, `app/test/{relay,device}.test.ts`
- Modify: `app/operator.ts` (mount the relay), `app/src/screens/Setup.tsx` (step 2 offers terminal or phone), `app/src/lib/spend.ts` (sign through `DeviceApprover`), `app/src/lib/store.ts` (`device` field)

**Interfaces:**
- Consumes: `originAllowed` (Task 2), `parseSignRequest` (Task 2), `BrowserKey` (Task 4, reused on the phone for its own key), `transferApprovalDigest`.
- Produces:
  - Relay, in the operator's memory (no disk), keyed by an unguessable `pairId` (16 random bytes, hex): `POST /relay/:pair/identity {identity}` (once); `GET /relay/:pair/identity` → `Identity | 404`; `POST /relay/:pair/requests {request}` → `{requestId}`; `GET /relay/:pair/requests/next` → the oldest unanswered request or 204; `POST /relay/:pair/responses/:id` → accepts one answer `{leaf, envelope, identity}` or `{refused: true}`, then 409; `GET /relay/:pair/responses/:id` → the answer or 204. Requests expire after 10 minutes; at most 16 open per pair.
  - `interface DeviceApprover { identity(): Promise<Identity>; sign(req: SignRequest): Promise<{leaf: number; envelope: Hex; identity: Identity}> }` with `bridgeDevice()` (Task 2's `/device`) and `phoneDevice(pairId)` (relay, polling every 1 s, rejects with "refused on the device" on a refusal). The store gains `device: {kind: "bridge"} | {kind: "phone"; pairId: string}`.
  - `#/device?pair=<id>` (no sidebar, header "Device (software stand-in, on your phone)"): first open makes the phone's own key (seed and used list in the phone's storage), shows its backup words once, posts its identity; then waits for requests and shows each one's decoded fields (chain, stealth account, token, amount, destination, max fee, valid until) with Approve and Refuse. Approve computes the digest itself from those fields (a digest in the request is ignored), records the key as used, signs, and answers.
  - Setup step 2: "Use the device terminal (this computer)" or "Use your phone": a QR of the device link and "waiting for your phone".

- [ ] **Step 1: Write the failing tests.** `relay.test.ts`: a request posted to pair A is not visible from pair B; a second answer to the same request gets 409; an unknown pair's `GET /identity` is 404; a `POST` with a foreign `Origin` is 403; the 17th open request is refused. `device.test.ts`: `approveOnPhone(req, key)` signs the digest computed from the request's fields even when the request carries a different `digest` field; the key is recorded as used before the envelope exists (reuse Task 4's `persist` pattern).
- [ ] **Step 2: Run** `cd app && bun test test/relay.test.ts test/device.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` — Expected: PASS. Manual: Setup with "Use your phone" (a second browser window on `#/device?pair=…` stands in for the phone), then a spend — Expected: the request appears on the device page, Approve completes the spend.
- [ ] **Step 5: Commit** `feat(app): phone approver relayed through the operator`.

### Task 13: Public demo through a Cloudflare Tunnel

**Files:**
- Create: `app/serve.ts`, `app/gate.ts`, `app/public.ts`, `app/test/gate.test.ts`
- Modify: `app/operator.ts` (faucet and deploy guards), `app/package.json` (`build`, `public` scripts), `README.md` ("Public demo" section)

**Interfaces:**
- Produces:
  - `allowRpc(body: unknown, allowed: ReadonlySet<string>): boolean` — true only when every call (single or batch, at most 50) names an allowed method. `ETH_METHODS`: `eth_chainId, net_version, eth_blockNumber, eth_getBlockByNumber, eth_getBalance, eth_getCode, eth_getTransactionCount, eth_call, eth_estimateGas, eth_gasPrice, eth_maxPriorityFeePerGas, eth_feeHistory, eth_getLogs, eth_sendRawTransaction, eth_getTransactionReceipt, eth_getTransactionByHash`. `SIDECAR_METHODS`: `eth_sendFrameTransaction, eth_chainId`. Everything else is refused with 403, notably `ethrex_submitPrivilegedFrameTransaction` and any `debug_`, `admin_`, `txpool_`, `engine_` method.
  - `serve.ts` on `127.0.0.1:8080`: `app/dist` with an SPA fallback; `/rpc` and `/sidecar` through `allowRpc`; `/canary` GET only; `/operator` passed through. `/device` is never served publicly.
  - Operator guards: the faucet serves one address once per 10 minutes and at most 30 times an hour; `/deploy` only deploys a commitment whose stealth address already holds tUSDC (each deploy costs ~11M gas).
  - `bun run public`: `vite build`, then the operator and `serve.ts`, then `cloudflared tunnel --url http://127.0.0.1:8080` wrapped in `systemd-inhibit --what=sleep:idle --why="postcurve public demo"`; prints the `https://….trycloudflare.com` URL and passes it to the services as `POSTCURVE_APP_ORIGINS`. If `cloudflared` is missing, print the install line and stop.

- [ ] **Step 1: Write the failing tests** in `gate.test.ts`: `eth_call` allowed; `ethrex_submitPrivilegedFrameTransaction` refused; a batch of `[eth_call, debug_traceTransaction]` refused; a batch of 51 refused; a non-JSON body refused; `eth_sendFrameTransaction` allowed only with `SIDECAR_METHODS`. Faucet limiter: a second request for the same address within 10 minutes is refused; the 31st request in an hour is refused. Deploy guard: a commitment whose address holds no tUSDC is refused.
- [ ] **Step 2: Run** `bun test test/gate.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` — Expected: PASS. Then `bun run public` — Expected: a trycloudflare URL; opening it on a phone shows the app; `curl -s -X POST <url>/rpc --data '{"jsonrpc":"2.0","id":1,"method":"ethrex_submitPrivilegedFrameTransaction","params":[]}'` gets 403.
- [ ] **Step 5: Commit** `feat(app): public demo through a Cloudflare Tunnel`.

