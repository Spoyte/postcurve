# postcurve app: design

Status: 2026-11-06, 22:50 IST. Screen list, layout and look chosen by the author; everything
marked *(builder's call made in design)* was decided while writing this and can be revisited.
Parent design: [design.md](design.md) (its goals, anti-goals and constraints all apply here).

## Intent

The browser app is what judges see in the 3-minute demo video, and the everyday face of
postcurve. The author wants three moments to stick:

1. **The keys change.** Every spend uses up one-time keys that can never sign again.
2. **The hidden transaction, paid by the paymaster.** Bob pays an address nobody can link to
   Alice; she spends from it without ever holding ETH; the paymaster pays the gas and takes its
   fee in test USDC.
3. **The alert.** The canary fires when a large, long-dormant, exposed address suddenly moves.

The app must look good: it carries the pitch.

## Decided by the author

- **Layout:** a wallet app with a sidebar, one screen at a time. From the "guided story"
  alternative it keeps one idea: every screen makes its one moment big and obvious.
- **Look:** "Bunker". Dark background `#0b0f14`, sidebar `#0e131a`, panels `#121821` with
  `#1e2733` borders, text `#d7dee8`, muted `#7d8898`, mint accent `#5eead4` (safe, hash-only,
  primary buttons), amber `#f5b14c` (warnings, waiting), red `#f87171` on `#3b1418` (alerts).
  System sans-serif for text, monospace for addresses, amounts and gas. Reference mockups:
  the "Bunker" Spend screen and the screen map from the brainstorm (`.superpowers/brainstorm/`,
  local only).
- **Screens, in demo order** (rough seconds of the video):
  1. **Check** (~20s): paste addresses; for each: key exposed / never signed / can't rule out,
     and the value at risk.
  2. **Receive** (~10s): Alice's private payment link and QR.
  3. **Pay** (~15s): Bob, in a second browser window, pays Alice's link.
  4. **Payments** (~15s): the scan finds Alice's payment and skips everyone else's.
  5. **Spend** (~50s): two approvals in two places, the five frames lighting up, a "what everyone
     else sees" panel, the one-time keys this spend used.
  6. **Keys** (~20s): a 256-key grid per approver; "Try to reuse a key" sends the same spend
     again and shows the mempool refusing it, live.
  7. **Canary** (~25s): the watchlist and the alert feed; any new alert also drops in as a bar
     across the top of every screen.
  0. **Setup**: first run only, not in the video.
- **Order of work:** Setup and screens 2–7 first (they sit on the SDK and contracts that already
  work end to end); Check after, because it needs new logic.

## Build order and cut order *(builder's call made in design)*

Build thin vertical slices in demo order (Setup, Receive, Pay, Payments, Spend, Keys, Canary,
then Check), so every commit leaves a demo that works up to that screen. If time runs short,
cut in this order: the Playwright run (replaced by a written run-through in the README), the QR
code (link only), the third key state on Keys (show unused and used on-chain only), then Check.
The anti-goals below never bend for the video.

## Goals

- The full flow Setup → Receive → Pay → Payments → Spend → Keys runs against the local devnet in
  a browser, with real transactions admitted by the patched sidecar.
- The Canary screen shows real alerts from the canary service (`canary/tools/canary-service.ts`).
- Every screen is good enough to record at 1440×900 without editing around glitches.
- A newcomer can start the whole thing from the README.

## Non-goals

- Mobile layout, multiple user profiles, hosting, ENS names (later), the real Firefly (separate
  sub-project), reading canary alerts from Arkiv (later, part 8), the Move flow (later, part 9).

## Anti-goals (from design.md, applied to the UI)

- Nothing faked: no simulated transactions, no scripted refusals, no staged alert that didn't
  come from the canary. The replay button sends a real second transaction.
- Every non-final piece is labelled where it appears: **Device (software stand-in)**,
  **tUSDC · test token**, **Bob · ordinary ECDSA test account**, **local devnet**.
- No "quantum-safe" claim on anything ECDSA touches (Bob's payment, the operator's deploy). No
  "private" claim for what a spend reveals: the spend links the stealth account to the
  destination address, and the screen says so.
- A one-time key is never reused, whatever fails: the browser records a key as used before it
  produces the signature (`Approver.approve(digest, save)` already enforces this; `save` must
  write durably before it returns).
- Alice never needs ETH.
- No trackers, no CDN fonts or scripts: everything is bundled (CROPS).

## How it works

### Pieces *(builder's call made in design)*

- **`app/`**: Vite + React + TypeScript, Bun as the package manager and test runner. It imports
  the SDK from `../sdk/src` (the SDK has no Node-only imports in `src/`). The contract ABIs and
  the account creation code come from `contracts/out` at build time; addresses from
  `devnet/data/stealth-deployment.json`.
- **Starting it:** `cd app && bun run dev` starts the operator service and Vite together (a
  small Bun script, no extra dependency). The device bridge is started by hand in its own
  terminal, because that terminal is part of the demo. The Playwright run starts everything
  itself.
- **Vite dev-server proxy**, so the browser talks to one origin: `/rpc` → `127.0.0.1:18545`,
  `/sidecar` → `127.0.0.1:14337/rpc`, `/canary` → `127.0.0.1:8787`, `/device` → the device
  bridge, `/operator` → the operator service.
- **Operator service** (new, `app/operator.ts`, a small Bun HTTP server holding devnet keys
  through the existing `devnetKey()` helper in `sdk/scripts/deploy-stealth.ts`, never printed;
  it stands for "the postcurve operator" and is labelled so):
  - `POST /deploy {commitment}` deploys the stealth account through the factory (gas limit 40M,
    as in `e2e-stealth.ts`) and returns `{address, txHash}`. This is the sponsor deploy that
    design.md describes; the operator learns which stealth account is being spent, nothing more.
  - `POST /faucet {address}` sends Bob's fresh browser account a little ETH and mints it 100
    tUSDC, so no devnet private key ever reaches a browser.
- **Device bridge**: a `serve` mode added to `sdk/scripts/device-signer.ts`
  (`bun scripts/device-signer.ts serve --port 8790`). `GET /identity` returns its identity;
  `POST /sign` takes the same request JSON as the existing `sign` command, prints the request
  in its own terminal and waits for a typed `y`, then returns `{leaf, envelope, identity}`, or
  403 if refused. One request at a time. In the video this terminal sits beside the browser:
  two approvals in two places. It prints the decoded fields, as `sign` already does (chain,
  stealth account, token, amount, destination, max fee, valid until), and computes the digest
  itself from them: it never signs a digest it was handed, which is also what the Firefly will
  have to do.
- **Local services only answer the app.** The operator and the device bridge bind to
  `127.0.0.1` and reject any request whose `Origin` header is not the app's origin, so another
  web page can't ask for a signature or drain the faucet.

### What the browser stores

In the app origin's storage (localStorage is enough):
- the browser approver's seed and its used-key list;
- the three approver identities (public), the threshold (2) and the meta-address;
- the viewing key, derived from the paper seed at setup (`viewKeyFromSeed`);
- found payments and past spends (for the Keys screen and the replay button);
- seen alert ids.

The **paper seed is shown once and never stored**: setup keeps only what derives from it (its
public identity and the viewing key). So after setup the browser holds one of the three
approver keys, as design.md requires. Losing the viewing key costs privacy, never funds.

**When the devnet is redeployed** *(builder's call made in design)*: stored payments and spends
are keyed by chain id and paymaster address. If `stealth-deployment.json` no longer matches,
the app says the devnet was redeployed and offers "start fresh", which clears payments, spends
and the meta-address but keeps every used-key list: a used key stays used, which is always
safe. Anything beyond that (recovering from a half-finished devnet reset) is out of scope.

**Key trees are slow to build** (~1.1 s each, measured in Bun): build them in a Web Worker,
at setup and on every load (the browser approver's tree is rebuilt from its seed), with a
"preparing your keys" state, so the page never freezes on camera.

### Screens

- **Setup.** (1) Create the browser key and show its backup words. (2) Pair the device: read
  `GET /device/identity` (the device signer must have run `init`). (3) Make the paper recovery
  seed: show its words once, ask the user to confirm they wrote them down, derive the paper
  identity and viewing key, forget the seed. (4) Build the 2-of-3 meta-address. A "reset demo"
  action clears storage. Building one XMSS tree is ~260k keccak calls: run it in a Web Worker
  if it blocks the page for more than a moment.
- **Receive.** A link `<origin>/#/pay?to=<meta-address, base64url>` (1,217 bytes, ~1,620
  characters), a copy button and a QR code. One line on what it means: every payment lands at a
  brand-new address only Alice can find.
- **Pay (Bob's window, `#/pay`).** Not in Alice's sidebar. Bob's account is a fresh key made in
  this window, funded with "Get test funds" (operator faucet). Bob enters an amount and pays:
  the page runs `stealth.send(meta, deployment)`, transfers tUSDC to the stealth address and
  posts the ERC-5564 announcement (scheme 2, view tag as metadata), exactly as
  `e2e-stealth.ts` does. Then it shows the address Bob paid and that it had no history before.
- **Payments.** Scans announcer logs from the deployment block with `stealth.scan`, shows
  "N announcements scanned, M are yours", and lists each found payment with its balance and
  status (unspent, spent). Rescans every few seconds. A payment opens the Spend screen.
- **Spend.** Destination address (prefilled with a fresh address, editable), amount = balance −
  fee (fee 0.50 tUSDC, max fee 1.00, `validUntil` = chain head time + 1 hour, `maxFeePerGas`
  2 gwei as in `e2e-stealth.ts`). Spending is disabled when the balance is not above the max
  fee; the Pay screen asks for at least 1.00 tUSDC so a demo payment is always spendable. Steps, each shown
  as it happens: operator deploys the account if it has no code; browser approves; device
  approves (the screen waits on the bridge and says "approve in the device terminal"); the
  frame transaction (same five frames and limits as `e2e-stealth.ts`) goes to the sidecar; the
  five frames light up from the receipt's `frameReceipts`, with gas. Then:
  - **"What everyone else sees"**: the stealth account's public history (Bob's fresh account
    paid it; the operator deployed it; the spend), gas paid by the paymaster, 0 ETH ever held by
    the account, and the plain fact that this spend links the stealth account to the destination.
  - **The keys this spend used**: the two key numbers, and the browser's grid with them marked.
- **Keys.** One grid of 256 per approver (browser, device, paper). Three states per key:
  unused; used on-chain (`paymaster.isLeafUsed(identityHash, leaf)`, the source of truth); and
  used locally but never landed (signed for a spend that didn't go through; still never reused).
  The browser's local list covers its own grid; the device and paper grids come from the chain.
  **"Try to reuse a key"** resubmits the last spend's exact frames with the next nonce and shows
  the sidecar's refusal verbatim. It is enabled only once a spend's frames are stored.
- **Canary.** Polls `/canary/watchlist` and `/canary/alerts`. Watchlist rows: address, label,
  balance, exposure evidence, dormancy. Alerts as cards (`postcurve.canary.alert/v1`: severity,
  address, amount moved, exposure evidence, dormancy, the sweep transaction). An alert the
  browser hasn't seen raises the app-wide bar; dismissing it marks it seen. The sweep itself is
  staged from a terminal (`canary/demo/run-demo.sh`): a sweep is an outside event and the app
  never fakes one.
- **Check (built after the rest).** Paste one or more mainnet addresses. Per address: "exposed"
  when it has sent a transaction (nonce > 0) or is otherwise known to have signed; "never sent a
  transaction, but exposure can't be ruled out" (permits, EIP-7702 authorizations and
  contract-checked signatures also reveal keys) when the nonce is 0; "smart account: depends on
  its signers" when it has code. Value at risk: the ETH balance (tokens later). Reads go through
  a configurable RPC URL; Anon-RPC becomes the default in its own task, once its endpoint and
  client are known. A "Move to a bunker" link points at Receive until Move exists.

### Look and motion

- Each screen leads with its moment, large: the Spend screen's frames and burned keys, the Keys
  screen's grids, the alert card.
- Motion is short and meaningful only: a frame lights up when its status arrives; a newly used
  key pulses once; the alert bar slides in. Nothing loops.
- The sidebar: postcurve wordmark, Check, Receive, Payments, Keys, Canary (with an unread
  count). Setup replaces the sidebar until it is done.

## Testing *(builder's call made in design)*

- `bun test` for the app's logic modules: the spend builder produces the same frames as
  `e2e-stealth.ts`; storage writes the used key before the signature is returned; the keys
  screen merges local and on-chain state correctly; the alert bar shows only unseen alerts.
- One scripted browser run (Playwright) of Setup → Pay → Payments → Spend → replay against the
  local devnet, with the test typing `y` into the device bridge's terminal (stdin), so the
  device approval is still a typed confirmation.

## Left to the builder

Component structure, state handling, the QR library, Web Worker use, exact copy beyond the
labels above, and animation details within "short and meaningful".
