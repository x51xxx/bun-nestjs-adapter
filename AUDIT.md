# Audit — `src/adapters`, `src/http`, `src/interceptors`

Date: 2026-07-26 · Commit: `d758cd3` · Runtime: Bun 1.3.5

**Baseline:** `bun run test` → **102 pass / 10 skip / 0 fail**. Everything below is a
*coverage gap*, not a regression: no existing test exercises these paths.

Every finding marked **[confirmed]** was reproduced against a live `Bun.serve`
instance; the probe code is inlined with each one.

**Status:** H1, H2, H3, M1, M3, M4, M5 are **fixed**, plus L1 and L3 (which
share a root cause with M3 and H1 respectively). Regression tests live in
`tests/integration/audit-h1-h2.spec.ts` and `tests/integration/audit-routing.spec.ts`;
both run their cases through *both* dispatchers. Suite after the fixes:
145 pass / 10 skip / 0 fail. Still open: M2, M6, M7 and the remaining L-series.

---

## H1 — The `Promise<Response>` is never guaranteed to settle → hung connections · **FIXED**

**Root cause.** `makeBunResponse()` hands out a bare `resolve` and tracks
completion with two ad-hoc booleans (`finished`, `headersSent`) that the
streaming shim sets *inconsistently*. There is no single "settled" flag, so
several code paths can leave the per-request promise pending forever. Bun never
times these out — the socket stays open, the connection leaks.

The failure mode is a **hang**, not a 500. That is what makes this the top
finding: an app that throws mid-SSE looks healthy until the file-descriptor
table fills up.

### H1a — throw after `res.write()` **[confirmed]**

`ensureStreaming()` (`src/http/response.ts:206`) sets `res.headersSent = true` but
**not** `res.finished`. So when the handler later throws, `_reject()`
(`src/http/response.ts:55`) passes its `if (this.finished) return` guard, calls
`resolve()` on an already-settled promise — a silent no-op — and returns.
`streamCtrl` is orphaned: never `.close()`d, never `.error()`d.

```ts
@Get('boom-after-write')
async boom(@Res() res: any) {
  res.write('partial');
  throw new Error('exploded mid-stream');
}
// → Nest logs "ERROR [ExceptionsHandler] Error: exploded mid-stream"
// → client: TIMEOUT/HANG (no bytes after "partial", stream never closes)
```

### H1b — `notFoundHandler` that doesn't write

`dispatchNotFound()` (`src/adapters/bun-http-adapter.ts:770`) invokes the handler
with a **no-op `next`**: `this.notFoundHandler(req, res, () => {})`. A handler
that delegates via `next()` instead of writing settles nothing. Read-confirmed;
not reproduced (Nest's own 404 handler always writes).

### H1c — middleware that neither calls `next()` nor writes

`runGlobalMiddleware()` (`src/adapters/bun-http-adapter.ts:715`) `await`s a
`new Promise<void>` that only settles from `next()` / a returned thenable. Express
has the same shape, but Express holds a real socket that its server can time out;
here the promise *is* the response.

**Suggested fix (one change, covers all three):** add a `settled` boolean owned by
`makeBunResponse`, set it in a single `settle(response)` helper that every exit
point routes through, and make `_reject` in streaming mode call
`streamCtrl.error(err)` (or `close()`) instead of a dead `resolve()`.

---

## H2 — SSE is broken on the fallback `fetch` dispatcher **[confirmed]** · **FIXED**

`buildFetchRequest()` (`src/http/request.ts:241`) does **not** attach the
EventEmitter methods or `NOOP_SOCKET` that `buildNativeRouteRequest()` attaches at
`src/http/request.ts:222-232`. Nest's `RouterResponseController.sse()` calls
`request.on('close', …)` unconditionally.

Consequence: SSE works on the native-routes fast path and **500s** the moment any
middleware, static-asset mount or `enableCors()` is present — i.e. in most real
apps.

```
P7 slow SSE -> status=500 {"statusCode":500,"message":"Internal server error"}
    TypeError: request.on is not a function
      at @nestjs/core/router/router-response-controller.js:123:21
P8 fast SSE -> status=200   ✔
```

**Fix:** extract the emitter/socket grafting into a shared helper and call it from
both builders.

---

## H3 — Request-shim contract drift (`buildNativeRouteRequest` vs `buildFetchRequest`) · **FIXED**

H2 and M1 are two symptoms of the same thing: two hand-maintained builders that
have diverged. Full diff of the two functions as they stand:

| Field | Native routes (fast path) | `fetch` dispatcher (slow path) | Impact |
|---|---|---|---|
| `on/once/off/removeListener/emit` | attached (`req.ts:223-228`) | **absent** | H2 — SSE 500s |
| `socket` (`NOOP_SOCKET`) | attached | **absent** | H2 |
| abort → `'close'` bridge | wired via `bunReq.signal` (`req.ts:183`) | **absent** | client-disconnect never observed |
| `ip` | hardcoded `'127.0.0.1'` | `x-forwarded-for[0]` **unvalidated**, else `127.0.0.1` | M1 |
| `body` | lazy getter + setter over `bodyResolved` | eager plain value | different `req.body` identity semantics; the getter can hand back `undefined` if read before `maybeParseBody` |
| `params` | from Bun's native matcher | `EMPTY_PARAMS`, filled later by `runRouteChain` | wildcard params lost (M3) |
| `get`/`header` | closes over local `headers` | uses `this.headers` | behaves differently if `req` is destructured |

**Fix:** collapse to one builder that takes the already-computed
`pathname/fullPath/query`, and keep only the params/body-timing difference.

---

## M1 — `req.ip`: inconsistent, and spoofable where it works **[confirmed]** · **FIXED with H3**

```
fast path, X-Forwarded-For: 9.9.9.9  →  {"ip":"127.0.0.1"}   (header ignored)
slow path, X-Forwarded-For: 9.9.9.9  →  {"ip":"9.9.9.9"}     (header trusted blindly)
```

Two problems:

1. **Fast path never reports a real client IP.** Bun exposes
   `server.requestIP(req)`; it isn't used anywhere. Rate limiters, audit logs and
   IP allowlists silently see `127.0.0.1` for every request.
2. **Slow path trusts `X-Forwarded-For` with no `trust proxy` equivalent.** Any
   client can set the header. Express requires opting in via `app.set('trust proxy')`
   precisely to avoid this. As written, `@nestjs/throttler` keyed on `req.ip` is
   trivially bypassed whenever the app happens to use middleware.

**Fix:** thread `server.requestIP()` through both builders as the base value, and
gate XFF behind an explicit adapter option (default off).

---

## M5a — `HEAD` reaching a streaming route leaks the source · **found while fixing M5, FIXED**

Not present before M5: once `HEAD` falls back to the `GET` handler, it can reach
an `@Sse()` route. Bun discards the body of a HEAD response, which means it never
*reads* the `ReadableStream` — so the observable produced into a buffer nobody
drained and the subscription never unwound. Measured before the guard: 70
emissions and counting, `unsubscribed === false`, still ticking after
`app.close()`.

`makeBunResponse` now refuses to open a stream for a HEAD request: it settles
headers-only, swallows subsequent writes, and emits `'close'` on the request so
the source tears down. After: 0 emissions, torn down. This is H1's failure mode
re-entering through the M5 door, and it is the reason the settle/stream state
belongs in one place.

---

## M2 — `enableCors()` swallows user-defined `OPTIONS` routes **[confirmed]**

`handle()` (`src/adapters/bun-http-adapter.ts:634`) short-circuits **every**
`OPTIONS` request to 204 once CORS is enabled:

```ts
if (req.method === 'OPTIONS') { res.statusCode = 204; return this.end(res); }
```

```ts
@Options('opt') opt() { return { custom: 'options' }; }
// with app.enableCors():  OPTIONS /opt → 204 ""   (handler never runs)
```

The `cors` package only preflights when `access-control-request-method` is
present, and otherwise calls `next()`. **Fix:** guard on that header.

---

## M3 — Wildcard routes: fast path and slow path disagree **[confirmed]** · **FIXED**

Nest 11 registers `@Get('files/*path')` verbatim as `GET /files/*path`
(verified by instrumenting `registerRoute`).

* **Fast path** — `toBunRoutePath()` forwards the string to Bun's native matcher,
  which matches it. But `bunReq.params` comes back empty, so the captured segment
  is **lost**: `GET /files/a/b.txt → 200 {"params":{}}`.
* **Slow path** — `compilePath()` (`src/http/router.ts:110-120`) has no case for a
  named wildcard; `*path` falls into the `seg.replace(/[.*+?^${}()|[\]\\]/g, …)`
  branch and is escaped as the **literal** `\*path`:

```
compilePath('/files/*path')  → ^\/files\/\*path\/?$
compilePath('/a/{*splat}')   → ^\/a\/\{\*splat\}\/?$
```

```
slow dispatcher: GET /files/a/b.txt → 404 Cannot GET /files/a/b.txt
```

So the same controller returns 200 or 404 depending on whether the app registered
middleware. Bare `/any/*` is fine (the `seg === '*'` case).

**Fix:** handle `*name` / `{*name}` in `compilePath` (emit `(.*)` + push the key),
and read Bun's wildcard param on the fast path.

---

## M4 — `use()` prefix matching has no path-boundary check **[confirmed]** · **FIXED**

`runGlobalMiddleware()` uses a raw `req.path.startsWith(mw.prefix)`
(`src/adapters/bun-http-adapter.ts:713`):

```ts
c.apply(MW).forRoutes('user');
// GET /user   → {"hit":"YES"}
// GET /users  → {"hit":"YES"}   ← should not run
```

`matchStatic()` (`src/http/static.ts:41-45`) already implements the correct
boundary-aware check. Same logic, not shared.

---

## M5 — `HEAD` on a `GET` route returns 404 **[confirmed]** · **FIXED**

```
fast path: HEAD /ping → 404
slow path: HEAD /ping → 404
```

`matchAll()` requires an exact method match or `ALL`; `buildBunRoutes()` only
emits the methods Nest registered. Express and Fastify both auto-serve `HEAD`
from the `GET` handler with the body stripped. Anything that probes with `HEAD`
(health checks, `curl -I`, some CDNs, link checkers) breaks.

---

## M6 — Multipart size limits are enforced *after* the file is in memory

`src/interceptors/bun-file-interceptor.ts:96-106`:

```ts
const file = await fileFromFormDataEntry(key, value);   // ← whole file → Buffer
if (limits?.fileSize !== undefined && file.size > limits.fileSize) {
  throw new PayloadTooLargeException(...);              // ← too late
}
```

`fileFromFormDataEntry` does `Buffer.from(await value.arrayBuffer())`. By the time
the limit is checked the allocation already happened, so `limits.fileSize` is a
*response* policy, not a memory guard — a 2 GB upload against `fileSize: 1_000_000`
still buffers 2 GB. `limits.files` has the same shape (counted post-buffer, and
`source.formData()` has already materialised every part before the loop even
starts).

Secondary: `BunFilesInterceptor`'s `maxCount` silently truncates
(`list.slice(0, maxCount)`) where Multer throws `LIMIT_UNEXPECTED_FILE`; and a
second interceptor on the same route hits `Body already used` because
`source.formData()` isn't memoised on the request.

**Note:** a true streaming guard isn't reachable through `Request.formData()`. The
honest fix is a `content-length` pre-check before calling `formData()`, plus
documenting that `fileSize` is post-buffer.

---

## M7 — Static assets: the pathname is never percent-decoded **[confirmed]**

`handle()` slices `pathname` straight out of the raw URL and hands it to
`matchStatic()`. Nothing decodes it.

```
file on disk: "my file.txt"
GET /s/my%20file.txt → 404
```

Any static asset with a space or non-ASCII character in its name is
unreachable. (The traversal guard in `serveStatic` is fine *because* of this — it
also means `%2e%2e%2f` can't traverse — so decode and re-check the guard together,
not separately.)

Also missing on the static path, for a file server: `Range`, `ETag`,
`Last-Modified`/`If-None-Match`, `Cache-Control`. Every request re-serves 200 with
the full body.

---

## L1 — Optional route params never match without the segment **[confirmed]** · **FIXED with M3**

`compilePath('/opt/:id?')` → `^\/opt\/([^/]+)\/?$`. The `?` is stripped from the
*key name* (`router.ts:112`) but the group stays mandatory:

```
GET /opt → 404 Cannot GET /opt
```

## L2 — `compilePath` mangles multi-param segments

`/x/:a-:b` → one group with key name `"a-:b"`. Unit-level only; not confirmed that
Nest emits this shape.

## L3 — `reply()` after `write()` silently drops the body · **FIXED with H1**

`reply()` guards on `response.finished`, which streaming mode leaves `false`
(H1a). So `res.write('a'); return {...}` calls `_resolve()` on a settled promise —
the JSON is discarded with no error. Same class as H1.

## L4 — WebSocket `error` events are dead code

Neither `STANDALONE_WEBSOCKET_HANDLERS` (`bun-ws-adapter.ts:160`) nor the
shared-port handlers in `http/server.ts:97-120` register Bun's `error` callback,
and nothing ever calls `client.__onError`. So `bindErrorHandler()`'s
`server.on('error', …)` never fires — WS errors are invisible.

## L5 — Gateways created after `listen()` can't publish

`BunHttpAdapter.listen()` back-fills `wsServer.bunServer` for every entry in
`wsPaths` (`bun-http-adapter.ts:117`). A gateway registered later (lazy module)
keeps `bunServer === null`, and `BunWsServer.publish()` returns `0` silently.
Same freeze-at-boot class as the documented lazy-route limitation.

## L6 — Dead code

* `ServerEntry.serverEmitter` (`bun-ws-adapter.ts:29`) — assigned, never read.
* `CompiledRoute.isMiddleware` / the `route.method === 'USE'` branch in
  `matchAll()` — `add()` is never called with `'USE'` (`use()` goes to
  `router.middleware`).
* `res.body` is written on every reply path but only ever read by tests.

## L7 — Slow-path routing is O(routes) per request

`matchAll()` (`router.ts:56`) runs every compiled regex against every request. The
fast path uses Bun's native matcher, so this only bites apps that use middleware —
which, given H2/M3/M4, is exactly the population that already gets degraded
behaviour. A method-bucketed index (the `byPath` map already exists) would cut it.

## L8 — Cookies: `maxAge` doesn't imply `Expires`

`res.cookie(name, val, { maxAge })` emits only `Max-Age`
(`response.ts:127-129`). Express emits both for IE/legacy-proxy compatibility.
Minor, but a behavioural difference from the Express adapter it mirrors.

---

## Ranked fix order

| # | Finding | Why first |
|---|---|---|
| 1 | **H1** unsettled promise → hang | leaks connections; silent; one structural fix covers H1a/b/c + L3 |
| 2 | **H2 / H3** shim drift | SSE is broken for any app with middleware; merging the builders retires a whole bug class |
| 3 | **M1** `req.ip` | security-relevant (spoofable rate-limit key) |
| 4 | **M3 / M4 / M5** routing semantics | silent fast-path vs slow-path divergence — the worst kind to debug |
| 5 | **M2 / M7** CORS OPTIONS, static decoding | straightforward, well-scoped |
| 6 | **M6** upload limits | at minimum, document that `fileSize` is post-buffer |
| 7 | L-series | cleanup |

**Cross-cutting recommendation:** most of the medium findings are *fast-path vs
slow-path divergence*. A test helper that runs the same assertion set through both
dispatchers (parameterise the existing integration specs over
`withMiddleware: false | true`) would have caught H2, M3 and M1 mechanically.
