import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  // Decorator metadata is critical for Nest DI; tsup uses the TS compiler when
  // experimentalDecorators is on, so we leave the host tsconfig in charge.
  target: 'es2022',
  external: [
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/websockets',
    'rxjs',
    'tslib',
    'bun',
    'node:events',
    'node:fs',
    'node:path',
    'node:stream',
  ],
});
