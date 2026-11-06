// The browser's approver key, held in a Web Worker. `persist` runs here on the main thread and must
// write the used-key list durably before it returns; if it throws, no signature is produced.

import type { Hex } from "viem";
import type { Identity } from "@postcurve/sdk";

const spawn = () => new Worker(new URL("./keys.worker.ts", import.meta.url), { type: "module" });

export class BrowserKey {
  private next = 1;
  private waiting = new Map<number, { resolve: (v: { leaf: number; envelope: Hex }) => void; reject: (e: Error) => void }>();

  private constructor(
    private readonly worker: Worker,
    readonly identity: Identity,
    private readonly persist: (used: number[]) => void,
  ) {
    worker.onmessage = (e: MessageEvent) => this.onMessage(e.data);
  }

  static open(seed: Hex, used: number[], persist: (used: number[]) => void): Promise<BrowserKey> {
    const worker = spawn();
    return new Promise((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message || "key worker failed"));
      worker.onmessage = (e: MessageEvent) => {
        if (e.data?.type === "ready") resolve(new BrowserKey(worker, e.data.identity as Identity, persist));
      };
      worker.postMessage({ type: "init", seed, used });
    });
  }

  approve(digest: Hex): Promise<{ leaf: number; envelope: Hex }> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: "approve", id, digest });
    });
  }

  close(): void {
    this.worker.terminate();
  }

  private onMessage(m: any): void {
    if (m.type === "save") {
      try {
        this.persist(m.used as number[]);
        this.worker.postMessage({ type: "saved", id: m.id });
      } catch (err) {
        this.worker.postMessage({ type: "save-failed", id: m.id, message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const w = this.waiting.get(m.id);
    if (!w) return;
    this.waiting.delete(m.id);
    if (m.type === "approved") w.resolve({ leaf: m.leaf, envelope: m.envelope });
    else w.reject(new Error(m.message ?? "approval failed"));
  }
}

/** The public identity of a seed (used for the paper seed, which is never stored). */
export function identityFromSeed(seed: Hex): Promise<Identity> {
  const worker = spawn();
  return new Promise<Identity>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(e.message || "key worker failed"));
    worker.onmessage = (e: MessageEvent) => {
      if (e.data?.type === "identity") resolve(e.data.identity as Identity);
    };
    worker.postMessage({ type: "identity", id: 0, seed });
  }).finally(() => worker.terminate());
}
