---
'@trishchuk/bun-nestjs-adapter': minor
---

Raise the `engines.bun` floor from `>=1.2.0` to `>=1.3.0`.

The `1.2.0` floor was never exercised — CI has pinned 1.3.x and now 1.4.0, and
the README badge has advertised "Bun 1.3+" the whole time. The field now says
what the project actually supports, and the badge, `AGENTS.md`, `docs/` and the
bug-report template agree with it.

Unrelated to `useStaticAssets({ native: true })`, which keeps its own runtime
check and falls back to the classic mount below Bun 1.4.0.
