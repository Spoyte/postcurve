// Holds the browser's approver key off the main thread (building its tree takes about a second).
// The SDK's Approver enforces "record the key as used, then sign"; the record itself is written by
// the main thread (Web Workers have no localStorage), so `save` waits for its acknowledgement.

import { hexToBytes, type Hex } from "viem";
import { Approver } from "@postcurve/sdk";

type In =
  | { type: "init"; seed: Hex; used: number[] }
  | { type: "approve"; id: number; digest: Hex }
  | { type: "saved"; id: number }
  | { type: "save-failed"; id: number; message: string }
  | { type: "identity"; id: number; seed: Hex };

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
let approver: Approver | null = null;
const saves = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

function save(id: number, used: number[]): Promise<void> {
  return new Promise((resolve, reject) => {
    saves.set(id, { resolve, reject });
    post({ type: "save", id, used });
  });
}

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  switch (m.type) {
    case "init":
      approver = Approver.fromSeed(hexToBytes(m.seed), m.used);
      post({ type: "ready", identity: approver.identity });
      break;
    case "approve":
      try {
        if (!approver) throw new Error("key not opened");
        const r = await approver.approve(m.digest, (used) => save(m.id, used));
        post({ type: "approved", id: m.id, leaf: r.leaf, envelope: r.envelope });
      } catch (err) {
        post({ type: "error", id: m.id, message: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "saved":
      saves.get(m.id)?.resolve();
      saves.delete(m.id);
      break;
    case "save-failed":
      saves.get(m.id)?.reject(new Error(m.message));
      saves.delete(m.id);
      break;
    case "identity":
      post({ type: "identity", id: m.id, identity: Approver.fromSeed(hexToBytes(m.seed)).identity });
      break;
  }
};
