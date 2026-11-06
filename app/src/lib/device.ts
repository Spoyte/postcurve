// The device approver: today the software stand-in in its own terminal (sdk/scripts/device-signer.ts
// serve, reached at /device). It computes the digest itself from the request's fields.

import type { Hex } from "viem";
import { signRequestJson, type Identity, type SignRequest } from "@postcurve/sdk";

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
