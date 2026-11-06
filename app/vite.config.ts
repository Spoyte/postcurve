import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// One origin for the browser: every local service is reached through this proxy (docs/ui-design.md).
const to = (target: string, prefix: string, replacement = "") => ({
  target,
  rewrite: (path: string) => path.replace(new RegExp(`^${prefix}`), replacement),
});

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@postcurve/sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)) },
    dedupe: ["viem", "@noble/hashes", "@noble/post-quantum", "@forshtat/hegota-support"],
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [".."] },
    proxy: {
      "/rpc": to("http://127.0.0.1:18545", "/rpc"),
      "/sidecar": to("http://127.0.0.1:14337", "/sidecar", "/rpc"),
      "/canary": to("http://127.0.0.1:8787", "/canary"),
      "/device": to("http://127.0.0.1:8790", "/device"),
      "/operator": to("http://127.0.0.1:8791", "/operator"),
    },
  },
  worker: { format: "es" },
});
