// Parameters of the postcurve v1 signature format. See spec/signature.md.

export const N = 32; // bytes per hash / word
export const W = 16; // Winternitz parameter
export const LEN1 = 64; // message digits
export const LEN2 = 3; // checksum digits
export const LEN = LEN1 + LEN2; // 67 chains
export const CHAIN_MAX = W - 1; // 15 steps from secret to public end
export const TREE_HEIGHT = 8;
export const LEAF_COUNT = 1 << TREE_HEIGHT; // 256
export const ENVELOPE_BYTES = N * (1 + LEN + TREE_HEIGHT); // 2432

export const DOMAIN = {
  SK: 1n,
  PUBSEED: 2n,
  CHAIN: 3n,
  LEAF: 4n,
  NODE: 5n,
} as const;
