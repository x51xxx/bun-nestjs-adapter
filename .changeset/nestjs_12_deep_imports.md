---
'@trishchuk/bun-nestjs-adapter': patch
---

Fix the published types under NestJS 12. `@nestjs/common` gained an `exports` map in v12 where `./*` resolves to `./*.js`, so the bare `@nestjs/common/interfaces` directory import no longer resolves — only `interfaces/index.js` exists on disk. `dist/index.d.ts` carried that specifier, so consumers on v12 got `TS2307`. Both import sites now name the concrete interface file, which resolves on 10, 11 and 12 alike.
