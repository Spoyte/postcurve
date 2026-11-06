// `bun run dev`: the operator service and the Vite dev server together. The device bridge runs in
// its own terminal (`cd sdk && bun scripts/device-signer.ts serve`), because that terminal is part
// of the demo.

const services: [string, string[]][] = [
  ["operator", ["bun", "operator.ts"]],
  ["vite", ["bunx", "vite"]],
];

async function pipe(stream: AsyncIterable<Uint8Array>, name: string, out: NodeJS.WriteStream) {
  let buf = "";
  for await (const chunk of stream) {
    buf += new TextDecoder().decode(chunk);
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  }
}

const procs = services.map(([name, cmd]) => {
  const p = Bun.spawn(cmd, { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe", env: process.env });
  pipe(p.stdout as unknown as AsyncIterable<Uint8Array>, name, process.stdout);
  pipe(p.stderr as unknown as AsyncIterable<Uint8Array>, name, process.stderr);
  return p;
});

const stop = (code: number) => {
  for (const p of procs) p.kill();
  process.exit(code);
};
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
await Promise.race(procs.map((p) => p.exited));
console.error("a service stopped; stopping the others");
stop(1);
