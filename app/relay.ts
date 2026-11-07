// The phone relay, in the operator's memory only: Alice's browser posts an approval request for a
// pair, the phone page (the device stand-in for visitors) picks it up, decides, and answers. A pair id
// is 16 random bytes made by Alice's browser at setup; it is the only thing linking the two.

import { parseSignRequest, signRequestJson } from "../sdk/src/signRequest";

const PAIR = /^[0-9a-f]{32}$/;
const TTL_MS = 10 * 60 * 1000;
const MAX_OPEN = 16;

type Answer = { leaf: number; envelope: string; identity: { root: string; pubSeed: string } } | { refused: true };
type Entry = { id: string; at: number; request: ReturnType<typeof signRequestJson>; answer?: Answer };
type Pair = { identity?: { root: string; pubSeed: string }; requests: Entry[] };

export type Relay = { handle: (request: Request, path: string) => Promise<Response | null> };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const isHex = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
const isIdentity = (v: any) => v && isHex(v.root) && isHex(v.pubSeed);

export function createRelay(now: () => number = Date.now): Relay {
  const pairs = new Map<string, Pair>();
  let seq = 0;
  const pair = (id: string) => {
    let p = pairs.get(id);
    if (!p) pairs.set(id, (p = { requests: [] }));
    p.requests = p.requests.filter((r) => now() - r.at < TTL_MS);
    return p;
  };
  const body = async (r: Request) => {
    try {
      return (await r.json()) as any;
    } catch {
      return {};
    }
  };

  return {
    async handle(request, path) {
      const m = /^\/relay\/([^/]+)\/(identity|requests\/next|requests|responses\/([^/]+))$/.exec(path);
      if (!m) return null;
      const [, pairId, what, responseId] = m;
      if (!PAIR.test(pairId!)) return json({ error: "bad pair id" }, 400);
      const p = pair(pairId!);
      const method = request.method;

      if (what === "identity") {
        if (method === "GET") return p.identity ? json(p.identity) : json({ error: "no device paired yet" }, 404);
        if (method === "POST") {
          if (p.identity) return json({ error: "this pair already has a device" }, 409);
          const { identity } = await body(request);
          if (!isIdentity(identity)) return json({ error: "identity must be {root, pubSeed}" }, 400);
          p.identity = { root: identity.root, pubSeed: identity.pubSeed };
          return json({ ok: true });
        }
      }
      if (what === "requests" && method === "POST") {
        let parsed;
        try {
          parsed = parseSignRequest((await body(request)).request);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "bad request" }, 400);
        }
        if (p.requests.filter((r) => !r.answer).length >= MAX_OPEN) return json({ error: "too many open requests" }, 429);
        const id = `${now().toString(36)}-${(++seq).toString(36)}`;
        p.requests.push({ id, at: now(), request: signRequestJson(parsed) });
        return json({ requestId: id });
      }
      if (what === "requests/next" && method === "GET") {
        const next = p.requests.find((r) => !r.answer);
        return next ? json({ requestId: next.id, request: next.request }) : new Response(null, { status: 204 });
      }
      if (responseId) {
        const entry = p.requests.find((r) => r.id === responseId);
        if (!entry) return json({ error: "unknown or expired request" }, 404);
        if (method === "GET") return entry.answer ? json(entry.answer) : new Response(null, { status: 204 });
        if (method === "POST") {
          if (entry.answer) return json({ error: "already answered" }, 409);
          const b = await body(request);
          if (b.refused === true) entry.answer = { refused: true };
          else if (Number.isInteger(b.leaf) && isHex(b.envelope) && isIdentity(b.identity)) entry.answer = { leaf: b.leaf, envelope: b.envelope, identity: b.identity };
          else return json({ error: "answer must be {leaf, envelope, identity} or {refused: true}" }, 400);
          return json({ ok: true });
        }
      }
      return json({ error: `no route for ${method} ${path}` }, 404);
    },
  };
}
