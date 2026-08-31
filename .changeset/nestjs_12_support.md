---
'@trishchuk/bun-nestjs-adapter': minor
---

Support NestJS 12.

- Widen the `@nestjs/common` / `@nestjs/core` / `@nestjs/websockets` peer range to `^10.0.0 || ^11.0.0 || ^12.0.0`.
- Fix `@Sse()` routes under Nest 12: `RouterResponseController.sse()` now takes its disconnect source from `request.socket ?? response` and subscribes with `.once('close', …)`, so the request shim's `socket` shares the request's `EventEmitter` instead of being a frozen no-op object. Without this every SSE route 500'd with `disconnectSource.once is not a function`. Nest 12's `@SseSignal()` works as a result.
- Implement the `query()` adapter method for Nest 12's new QUERY verb. `AbstractHttpAdapter.query()` delegates to `this.instance.query(...)`, which is `undefined` here, so a single `@QueryMethod()` route crashed the whole bootstrap.
- Keep SEARCH, QUERY and the WebDAV verbs off the native `Bun.serve({ routes })` map. Bun accepts only the seven standard verbs as method keys and throws `ERR_INVALID_ARG_TYPE` for anything else, so a `@Search()` route took the app down at `listen()` whenever it was on the native-routes fast path. Those verbs now fall through to the manual dispatcher while the standard verbs on the same path stay on the fast path.
