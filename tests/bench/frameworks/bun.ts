// Raw Bun.serve baseline (no framework). Uses `globalThis.Bun` so this file
// type-checks under tsc; only runs under the Bun runtime.
const ServeFn = (globalThis as any).Bun?.serve;
if (!ServeFn) {
  console.error('This benchmark target must be executed by Bun.');
  process.exit(1);
}

ServeFn({
  port: 3000,
  hostname: '0.0.0.0',
  fetch() {
    return new Response('Hello world');
  },
});
