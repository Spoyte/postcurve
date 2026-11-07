// The device approver, a software stand-in for the Firefly: either in its own terminal on this computer
// (sdk/scripts/device-signer.ts serve, reached at /device) or on a phone (#/device, through the
// operator's relay). Either way it computes the digest itself from the request's fields.

import type { Hex } from "viem";
import { parseSignRequest, signRequestJson, transferApprovalDigest, type Identity, type SignRequest } from "@postcurve/sdk";

export type DeviceAnswer = { leaf: number; envelope: Hex; identity: Identity };

export interface DeviceApprover {
  identity(): Promise<Identity>;
  sign(req: SignRequest): Promise<DeviceAnswer>;
}

export function bridgeDevice(): DeviceApprover {
  return {
    async identity() {
      const r = await fetch("/device/identity");
      if (!r.ok) throw new Error(`the device answered ${r.status}`);
      return (await r.json()) as Identity;
    },
    async sign(req) {
      const r = await fetch("/device/sign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signRequestJson(req)) });
      if (r.status === 403) throw new Error("refused on the device");
      if (r.status === 409) throw new Error("the device is busy with another request");
      if (!r.ok) throw new Error(`the device answered ${r.status}`);
      return (await r.json()) as DeviceAnswer;
    },
  };
}

/** The phone approver's signing rule: parse the request, compute the digest from its fields, sign that. */
export async function approveOnPhone(
  body: unknown,
  key: { identity: Identity; approve: (digest: Hex) => Promise<{ leaf: number; envelope: Hex }> },
): Promise<DeviceAnswer> {
  const req = parseSignRequest(body);
  const { leaf, envelope } = await key.approve(transferApprovalDigest(req.chainId, req.account, req.approval));
  return { leaf, envelope, identity: key.identity };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The device stand-in on a phone, reached through the operator's relay (relay.ts). */
export function phoneDevice(pairId: string): DeviceApprover {
  const base = `/operator/relay/${pairId}`;
  return {
    async identity() {
      const r = await fetch(`${base}/identity`);
      if (!r.ok) throw new Error("no phone paired yet");
      return (await r.json()) as Identity;
    },
    async sign(req) {
      const post = await fetch(`${base}/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: signRequestJson(req) }) });
      if (!post.ok) throw new Error(`the relay answered ${post.status}`);
      const { requestId } = (await post.json()) as { requestId: string };
      for (let i = 0; i < 600; i++) {
        const r = await fetch(`${base}/responses/${requestId}`);
        if (r.status === 200) {
          const a = (await r.json()) as DeviceAnswer | { refused: true };
          if ("refused" in a) throw new Error("refused on the device");
          return a;
        }
        if (r.status !== 204) throw new Error(`the relay answered ${r.status}`);
        await wait(1000);
      }
      throw new Error("the phone didn't answer within 10 minutes");
    },
  };
}

export const newPairId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
