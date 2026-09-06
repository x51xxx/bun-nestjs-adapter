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

## M6 — Multipart size limits are enforced *after* the file is in memory · **FIXED**

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

**Shipped (2026-09-06).** All three parts, with the Multer behaviour measured
first (`@nestjs/platform-express` + `multer` from the fixtures):

* **`limits.totalSize`** — a whole-request ceiling compared against
  `Content-Length` *before* `formData()` reads anything. It defaults to
  `fileSize * <max files> + 1 MiB` whenever `fileSize` is set and the file count
  is known, so the headline case (2 GB against `fileSize: 1_000_000`) is now
  refused up front rather than buffered and then rejected — without the app
  having to opt in. Explicit `totalSize` overrides it; `Infinity` disables it. A
  chunked upload has no `Content-Length` and still can't be pre-checked; Bun's
  `maxRequestBodySize` is the backstop, which is one more reason to expose it
  (Part 4).
  The ordering is pinned by a test that sends an *unparseable* multipart body:
  it comes back `413`, which it could not if the size check ran after the parse.
* **`maxCount`** now throws `BadRequestException('Unexpected field - <field>')`
  instead of `list.slice(0, maxCount)`. Silently dropping a file the client
  believes it uploaded is the worse failure of the two.
* **`formData()` is memoised** on the request, so two interceptors on one route
  share a single parse instead of the second one hitting `Body already used`.

Messages now match Multer's exactly — `File too large`, `Too many files`,
`Unexpected field - <field>` — since a client that switches platforms otherwise
sees different strings for the same condition. One existing test asserted the
old truncation behaviour and now asserts the 400.

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

---

# Audit — 2026-09-06

Date: 2026-09-06 · Commit: `56e5b80` · Runtime: **Bun 1.4.0** (latest released: 1.4.2)

**Baseline:** `bun run test` → **207 pass / 3 skip / 0 fail**.

Second pass over the same three directories. Every finding below marked
**[confirmed]** was reproduced against a live `Bun.serve` through a real
`NestFactory.create(...)` app; probe code is inlined. This section also
**corrects three claims** made in the 2026-07-26 audit above.

---

## Part 1 — status sweep of the 2026-07-26 findings

| # | 2026-07-26 status | Verified today | Note |
|---|---|---|---|
| H1a | FIXED | **partially** — no longer hangs, but the failure is now *invisible* | see **H6** below |
| H1 (premise) | — | **claim is wrong** | H1 argued "Bun never times these out — the socket stays open, the connection leaks". Measured: a handler whose promise never settles is **closed by Bun after 12.0 s** (default `idleTimeout`). The fix was still right; the leak argument for its priority was not. |
| H1b / H1c | FIXED | fixed (read) | `dispatchNotFound` passes a real `next` |
| H2 / H3 | FIXED | fixed | one `createRequestShim()`; SSE works on both dispatchers |
| M1 | FIXED | fixed | `server.requestIP()` + opt-in `setTrustProxy()` |
| M2 | open | **fixed 2026-09-06** — but the finding's *premise* was wrong; see the correction below |
| M3 / M4 / M5 / M5a | FIXED | fixed | `compilePath` handles `*name` / `{*name}` / `:id?`; `matchesPathPrefix` shared |
| M6 | open | **fixed 2026-09-06** | was unchanged at audit time; see the note under M6 |
| M7 | open | **fixed 2026-09-06** | was still open for *classic* mounts; both modes now share `decodeStaticSuffix` |
| L1 / L3 | FIXED | fixed | |
| L2 | open | still open | `/x/:a-:b` → one key named `a-:b` on the slow path; the native path correctly drops the route (`bunRoutesLoseParams`) |
| **L4** | open | **claim is wrong — see correction** | |
| **L5** | open | **appears fixed** (read-confirmed) | `BunWsAdapter.create()` back-fills `server.bunServer` from `getHttpServer().bunServer` at *create* time, so a gateway registered after `listen()` can publish |
| L6 | open | still open | `CompiledRoute.isMiddleware` + the `'USE'` branch in `collect()` are unreachable (`add()` is never called with `'USE'`); `ServerEntry.serverEmitter` still assigned, never read |
| L7 | open | still open | `matchAll()` is O(routes); only bites the slow path |
| L8 | open | still open | `maxAge` emits `Max-Age` without `Expires` |

### Correction to L4 — the proposed fix is not implementable

L4 says the `error` callback is "never registered" in
`STANDALONE_WEBSOCKET_HANDLERS` and `http/server.ts`. **Bun's
`WebSocketHandler` has no `error` callback at all** — the full set is
`open` / `message` / `close` / `drain` / `ping` / `pong`
(`node_modules/bun-types/serve.d.ts:330-430`).

So `BunWsClient.__onError` / `bindErrorHandler()` are dead by construction, not
by omission. The honest options are (a) delete `__onError` and document that WS
errors surface as `close` with a status code, or (b) synthesise an `'error'`
event from a non-1000 close code. `ping`/`pong` *are* available and unused —
see Part 4.

---

## Part 2 — new findings

### H4 — SSE and every long-lived stream is killed after 10 s **[confirmed]** · **FIXED**

`Bun.serve`'s `idleTimeout` defaults to **10 seconds**. The adapter never sets
it, and never calls `server.timeout(req, 0)` when `ensureStreaming()`
(`src/http/response.ts:254`) upgrades a response to a `ReadableStream`. Any SSE
feed, long-poll or slow download with a >10 s gap between chunks is dropped by
the runtime — with Bun printing its own warning to the server log.

```ts
@Sse('sse')
sse(): Observable<any> {
  return new Observable(sub => { sub.next({ data: 'hello' }); }); // one event, then silence
}
```

```
HTTP/1.1 200 OK … Transfer-Encoding: chunked
14\r\n\nid: 1\ndata: hello\n\n\r\n
<CLOSED BY SERVER after 12.0s>
warn: Bun.serve() timed out a request after 10 seconds. Pass `idleTimeout` to configure.
```

This is the single most production-visible defect found in this pass: a
heartbeat-less SSE endpoint — the default shape of every Nest `@Sse()`
tutorial — silently disconnects every client every 10 seconds.

**Fix — one option, not two.** Raising the global `idleTimeout` *cannot* solve
this: Bun caps it at 255 seconds.

```
Bun.serve({ idleTimeout: 3600 }) → throws: "Bun.serve expects idleTimeout to be 255 or less"
Bun.serve({ idleTimeout: 255  }) → accepted
```

The necessary fix is the per-request opt-out, `server.timeout(req, 0)`, called
from `ensureStreaming()` when a response upgrades to a stream. Measured against
raw `Bun.serve`, no Nest:

```
/plain  (idle stream, no timeout call)   → CLOSED by server after 12.0s
/keep   (s.timeout(req, 0) before reply) → STILL OPEN after 16s   ✔
```

Cost is plumbing, not logic: `makeBunResponse(adapter, req, resolve)` has
`req.bunRequest` but no `server` handle — `runBunRouteSingle` /
`runBunRouteChain` / `handle()` all receive one and would have to thread it
through. Exposing `idleTimeout` as an adapter option (Part 4) is still worth
doing for slow *uploads*, but it is not the SSE fix.

**Shipped.** `makeBunResponse()` takes an optional `RequestTimeoutSource`
(structural, like `RequestIpSource`), threaded from all three call sites, and
exposes `_disableIdleTimeout()`. It fires from `ensureStreaming()`, from
`streamNodeReadable()`, and from `reply()`'s `ReadableStream` branch — so
`@Sse()`, `StreamableFile`, a bare `Readable` and a handler that returns a web
stream directly are all covered, on both dispatchers. Regression tests in
`tests/integration/audit-h4-h5.spec.ts` assert the call through each dispatcher
and that a *buffered* response never touches the timer; the real 13 s
end-to-end check is behind `RUN_SLOW_TESTS=1` (verified passing).

### H5 — `enableCors({ origin: (origin, callback) => … })` emits no `Access-Control-Allow-Origin` **[confirmed]** · **FIXED**

`src/http/cors.ts:14` types `origin` as `(req: BunRequest) => string | boolean | …`.
That is **not** the signature Nest documents. Nest re-exports the `cors`
package's `CorsOptions`, whose function form is
`(requestOrigin: string, callback: (err: Error | null, origin?: boolean) => void) => void`.

An app that follows the Nest docs verbatim gets its function called with the
*request object* as `origin`, and a `callback` that is `undefined`. The return
value is `undefined`, so `originHeader` is never set and the header is omitted
entirely — CORS is silently off, and the browser blocks every cross-origin call.

```ts
app.enableCors({ origin: (origin, cb) => cb(null, true) });   // straight from the Nest docs
```
```
GET /ping (Origin: http://x) → 200, access-control-allow-origin: null
```

Worse than a crash: nothing is logged, and the adapter *does* emit the other
CORS headers, so the response looks CORS-enabled at a glance.

**Fix.** Detect arity: `fn.length >= 2` → call `fn(reqOrigin, (err, allow) => …)`
(the `cors` contract, sync-callback only, matching the module doc-comment's
existing "async forms unsupported" caveat); otherwise keep the current
`(req) => …` form. Both shapes then work.

**Shipped.** Arity dispatch as above, plus a shared `resolveStaticOrigin()` that
reduces every static shape — `true` / `'*'` / string / `RegExp` / array — to the
header value, so a callback answering `[/\.example$/]` behaves exactly like the
same value passed inline (the old one-argument path only understood `string` and
`true`). A callback that is *not* invoked synchronously now logs a one-time
warning instead of silently emitting nothing.

One cost, documented in `docs/http.md` and in the type's doc-comment:
`origin` is now a union of two function types with different arities, and
TypeScript declines to pick a contextual signature out of that. The
one-argument form therefore needs its parameter annotated
(`origin: (req: BunRequest) => …`) under `noImplicitAny`; the two-argument form
infers normally. Verified with `tsc --noImplicitAny` over every documented
shape.

### H6 — a handler that throws after `res.write()` is indistinguishable from success **[confirmed]** · corrects H1a

H1a's fix stopped the hang. But the rationale recorded for it — "erroring the
stream aborts the chunked response, which is the only way left to tell the
client it failed" (`src/http/response.ts:87-90`) — **does not hold on Bun 1.4.0**.
`streamCtrl.error()` makes Bun emit the *terminating* `0\r\n\r\n` chunk and
close cleanly:

```ts
@Get('boom')  async boom(@Res() res: any) { res.write('partial'); throw new Error('exploded'); }
@Get('ok')    async ok(@Res()  res: any) { res.write('partial'); res.end(); }
```
```
/boom → "HTTP/1.1 200 OK\r\n…\r\nContent-Length: 7\r\n\r\npartial"     ← byte-identical
/ok   → "HTTP/1.1 200 OK\r\n…\r\nContent-Length: 7\r\n\r\npartial"     ← to the success case
```

And in genuine chunked mode (headers already flushed, two 100-byte writes, then
a throw):

```
… Transfer-Encoding: chunked\r\n\r\n64\r\nAAA…\r\n64\r\nBBB…\r\n0\r\n\r\n   <close hadError=false>
```

The client sees a well-formed, complete `200`. A truncated payload is accepted
as final. There is no socket handle reachable from a `Response(stream)` body,
so the adapter cannot abort the connection itself.

**Next step:** re-run the probe on Bun **1.4.2** — 1.4.1's notes include
"fixed streaming response body failures" and a fix for handlers whose promises
never settle. If unchanged, this is an upstream report with the repro above.
Until then: (a) correct the misleading comment in `response.ts`, and (b) for
`@Sse()` specifically, emit a terminal `event: error` frame before erroring the
controller, which *is* observable by an `EventSource` consumer.

**Partially addressed (2026-09-06):** (a) is done — the comment in `_reject()`
now states what `.error()` actually buys (it settles the request instead of
hanging it) and what it does not (the client cannot tell a truncated response
from a complete one), and points at the in-band workaround. The behaviour itself
is unchanged and still needs the 1.4.2 re-check.

### M2 — `enableCors()` still swallows user-defined `OPTIONS` routes **[re-confirmed]** · **FIXED**

Unchanged since 2026-07-26. `handle()` (`src/adapters/bun-http-adapter.ts:~730`)
short-circuits **every** `OPTIONS` to 204 once CORS is on, whether or not the
request is a preflight:

```
OPTIONS /opt  (no Access-Control-Request-Method) → 204 ""    ← @Options('opt') handler never runs
OPTIONS /opt  (real preflight)                   → 204 ""
```

The `cors` package gates on `access-control-request-method` and otherwise calls
`next()`. Same one-line fix as before.

> ### Correction — the sentence above is wrong
>
> Read from the source both Nest platforms actually ship
> (`cors@2.8.5/lib/index.js:163`, `@fastify/cors/index.js:192`): **neither gates
> on `Access-Control-Request-Method`.** `cors` branches on `req.method ===
> 'OPTIONS'` alone and answers every one of them with the preflight headers and
> `optionsSuccessStatus`; `@fastify/cors` does the same, and only demands
> `Origin` + `Access-Control-Request-Method` when you opt into
> `strictPreflight: true` (default `false`).
>
> So the adapter's original behaviour *was* platform-express parity, and the
> first attempt at this finding — an unconditional ACRM gate, shipped in
> `ea09001` — moved it away from both references instead of towards them. The
> genuine gap was the missing escape hatch: on Express you keep your own
> `@Options()` route by passing `preflightContinue`, and the adapter had no such
> option.
>
> This is the same failure the 2026-07-26 audit warned about in its own closing
> line — a cause inferred rather than measured. Reading the reference
> implementation costs one `grep`.

**Shipped (2026-09-06, superseding `ea09001`).** Exact `cors` semantics: any
`OPTIONS` is a preflight, ended with `optionsSuccessStatus` (default `204`),
unless `preflightContinue: true` applies the preflight headers and falls through
to routing — which is how a user `@Options()` handler now owns the response. Both
options are new on `CorsOptions`. `Content-Length: 0` is set the way `cors` sets
it; measured on Bun 1.4.0, Bun drops it on a `204` and keeps it on the `200` an
app selects, which is the case the Safari workaround exists for.

### M7 — classic static mounts still never percent-decode the path **[re-confirmed]** · **FIXED**

The 2026-07-26 fix landed only on the **native** side (`decodeStaticSuffix()`).
`matchStatic()` → `serveStatic()` still hand the raw, still-encoded suffix to
`join()`:

```
file on disk: "my file.txt",  app.useStaticAssets(root, { prefix: '/s' })
GET /s/my%20file.txt → 404 {"message":"Cannot GET /s/my%20file.txt", …}
```

So the *same* file is reachable through `{ native: true }` and unreachable
through the default mount. Decode per segment (reuse `decodeStaticSuffix`) and
re-check the traversal guard in the same change — the guard currently only
works *because* nothing is decoded.

**Shipped (2026-09-06).** `serveStatic()` now runs `matched.rawRel` through the
same `decodeStaticSuffix()` the native mount uses and joins the decoded
segments, appending `entry.index` for a trailing slash. That one call replaces
the old `normalize()`/`includes('..')` guard, which is the point: decoding
without replacing it would have opened `%2e%2e%2f`. The now-dead `relPath` field
is gone from `StaticMatch`. A rejected path stays `403` on the classic mount
(`404` on the native one, mirroring Bun). Regression tests in
`tests/integration/audit-m2-m7.spec.ts` include a naive-decode trap: reverting
the guard while keeping the decode fails the `%2e%2e%2f` case.

### M8 — a second static mount on the same prefix is never consulted **[confirmed]** · **FIXED**

`matchStatic()` (`src/http/static.ts:46-56`) `return`s on the **first** entry
whose prefix matches. When `serveStatic()` then misses (ENOENT → `false`), the
request falls through to route dispatch — never to the next mount. Express's
`serve-static` chains mounts via `next()`.

```ts
app.useStaticAssets('/tmp/a', { prefix: '/s' });   // does not contain the file
app.useStaticAssets('/tmp/b', { prefix: '/s' });   // does
GET /s/only-here.txt → 404
```

**Fix.** Make `matchStatic` yield every matching entry (or return an array) and
have `handle()` walk them until one serves.

**Shipped (2026-09-06).** `matchStatic()` returns `StaticMatch[]`, and
`handle()` splits them: classic mounts are walked in registration order by
`serveStaticChain()` before route dispatch, while the first *native* match is
carried past dispatch to `finishNoRoute()` as before — the two run at different
stages, so they can't share one list. Verified against platform-express: first
mount wins a file both hold, the second answers what the first lacks, and a
route under the prefix still runs once every mount misses.

### M9 — a malformed JSON body is swallowed instead of rejected with 400 **[confirmed]** · **FIXED**

`parseRequestBody()` (`src/http/request.ts:132-152`) catches the parse error and
returns `NO_BODY`, so `req.body` stays `undefined`:

```
POST /json  content-type: application/json  body: "{oops"
→ 201 {"typeof":"undefined"}
```

`@nestjs/platform-express` (body-parser) answers **400 Bad Request** here.
As written, a syntax error in the payload surfaces much later as a confusing
DTO/`ValidationPipe` failure — or, on a route with no validation, as a handler
reading `undefined`.

**Fix.** Record the parse failure on the request and let the adapter settle a
400, or rethrow as `BadRequestException`. Keep the tolerant behaviour opt-in if
back-compat matters.

**Shipped (2026-09-06).** `parseRequestBody()` returns the `SyntaxError` instead
of dropping it; both builders put it on `req.bodyParseError` (it is produced
before any response exists, so the request is what carries it), and both
dispatchers wrap it in `BadRequestException` and route it through the handler
Nest registered with `setErrorHandler()`. The response matches
platform-express's shape exactly — `{"message":…,"error":"Bad
Request","statusCode":400}` — only the parser's wording differs, since Bun's
`Request.json()` says "Failed to parse JSON" where V8 says "JSON Parse error:
…". `rawBody` is still populated for the failed payload, because a webhook
verifier wants the bytes either way.

The three error-routing sites (`dispatchRoutes`, `runRouteChain`, and this one)
now share a `dispatchError()` helper instead of repeating the
errorHandler-or-`_reject` block.

### N1 — an empty JSON body yields `undefined`, not `{}` **[confirmed]** · **FIXED**

Found while measuring M9 against platform-express, not part of it. `body-parser`
hands the handler an empty object for a present-but-empty payload; the adapter
skips parsing entirely (`maybeParseBody`, `content-length: 0`) and leaves
`req.body` undefined.

```
POST /json  content-type: application/json  body: ""
platform-express → 201 {"body":{},"t":"object"}
bun adapter      → 201 {"t":"undefined"}
```

Matters for a `ValidationPipe` on a DTO with all-optional fields: `{}` validates,
`undefined` does not.

**Shipped (2026-09-06).** An empty JSON payload resolves to a **fresh** `{}` —
fresh because a handler may write to `req.body`, and a shared object would leak
between requests (there is a test for exactly that). It covers all three shapes
an empty payload arrives in: `Content-Length: 0`, no body at all, and a chunked
stream that closes immediately.

### N2 — a bare JSON scalar is accepted where `body-parser` rejects it **[confirmed]** · **FIXED**

Also found while measuring M9. `body-parser` defaults to `strict: true`, which
only accepts an object or an array at the top level:

```
POST /json  body: "just a string"
platform-express → 400 {"message":"JSON Parse error: …","error":"Bad Request","statusCode":400}
bun adapter      → 201 {"body":"just a string","t":"string"}
```

Same call as N1: strictly a parity gap, but tightening it would start rejecting
payloads that work today.

**Shipped (2026-09-06).** `body-parser` decides on the payload's first
non-whitespace character; the adapter decides on the *parsed value* instead
(`typeof value !== 'object' || value === null`), which accepts and rejects
exactly the same set for anything that parses, and — unlike a first-char check —
works on the JSON fast path, where the text is never materialised.

**The fast path needed one adjustment to get here.** `Request.json()` cannot
tell an empty payload from a malformed one once the stream is consumed, and
those two now have different answers (`{}` vs 400). So the fast path is taken
only when a declared, non-zero `Content-Length` has already ruled the empty case
out; a chunked JSON upload takes the buffered path, which sees the bytes and can
tell. All eleven reference cases — empty, no body, no content type, whitespace,
`null`, `123`, `"str"`, `true`, `[1,2]`, leading whitespace, chunked — now match
platform-express on both dispatchers. Only the error prose differs.

**One `.replace()` of collateral value:** both builders now share a single
`resolveRequestBody()` gate instead of carrying their own copies of the
"is there a body worth parsing" conditions — the drift that produced H3.

### N3 — a file under an unexpected field name is ignored, not rejected **[confirmed]**

Found while measuring Multer for M6, not part of it. `FileInterceptor('f')`
rejects a multipart request that also carries a file under any *other* field;
the Bun interceptors ignore the extra part.

```ts
@UseInterceptors(FileInterceptor('f'))          // form carries both `f` and `g`
platform-express → 400 {"message":"Unexpected field - g", …}
bun adapter      → 201, the `g` part silently dropped
```

Same `LIMIT_UNEXPECTED_FILE` rule that now backs `maxCount`, just applied to
field *names* as well as counts. Left alone deliberately: it would start
rejecting forms that work today, and unlike M6 there is no memory-safety
argument forcing the change.

### L9 — `enableCors()` after `listen()` is a silent no-op **[confirmed]**

`use()` and `useStaticAssets()` both call `reloadRoutes()` when the server is
already listening. `enableCors()` (`bun-http-adapter.ts:~578`) does not — it
only sets `this.corsOptions`, so a server already on the native-routes fast path
keeps serving from a route map that never reaches the CORS branch in `handle()`.

```
await app.listen(0);
app.enableCors({ origin: true });
GET /who (Origin: http://x) → access-control-allow-origin: null
```

**Fix.** Three lines, identical to `use()`:
`if (this.httpServer?.listening) this.reloadRoutes();`

### L10 — body and query parsers disagree about duplicate keys **[confirmed]**

`parseQuery()` correctly collects repeats into an array; the urlencoded body
parser uses `Object.fromEntries(new URLSearchParams(…))`
(`src/http/request.ts:155`), which keeps only the last:

```
?a=1&a=2   → req.query = { a: ['1','2'] }
a=1&a=2    → req.body  = { a: '2' }        ← Express/qs gives ['1','2']
```

`parseQuery`'s own loop is right there and would fix it.

### L11 — `req.hostname` is wrong for an IPv6 `Host` header **[confirmed]**

`createRequestShim()` (`src/http/request.ts:220`) does
`hostHeader.split(':', 1)[0]`:

```
Host: [::1]:1234  →  req.hostname === "["
```

Strip the brackets first (Express returns `[::1]`).

### L12 — preflight-only CORS headers are emitted on every response · **FIXED**

`applyCorsHeaders()` unconditionally sets `access-control-allow-methods` (and
`access-control-allow-headers` when the request carries
`access-control-request-headers`) on **all** responses. The `cors` package sets
those only on a preflight. Confirmed in the M2 probe above: a plain
`GET /ping` carries `access-control-allow-methods: GET,HEAD,PUT,…`. Harmless to
browsers, but it is bytes on every response and a visible behavioural
difference from the Express adapter. Fixing M2 puts the gate in the right place
to fix this too.

**Shipped (2026-09-06).** `applyCorsHeaders()` takes an `isPreflight` flag and
splits the set exactly as `cors` does — `Allow-Methods`, `Allow-Headers` and
`Max-Age` describe a *future* request and go on the preflight only;
`Allow-Origin`, `Allow-Credentials` and `Expose-Headers` describe this one and
go on both. One existing test (`audit-fixes.spec.ts`, "exposedHeaders + maxAge
are emitted") had encoded the bug by asserting `Max-Age` on a plain `GET`; it
now asserts the split.

### L13 — `close()` does not await `Bun.serve`'s stop promise

`BunHttpServer.close()` (`src/http/server.ts:195`) calls `this.bunServer?.stop()`
and resolves immediately. On Bun 1.4 `stop()` **returns a Promise** (verified:
`server.stop(true).constructor.name === 'Promise'`).

Measured: an in-flight 700 ms request *does* still complete (Bun's non-forced
stop drains), but `app.close()` resolves after ~1 ms — before the server is
actually down. Anything that shuts the process down right after `await
app.close()` can cut those connections. Also, `stop()` is never called with
`true`, so there is no way for a caller to force-close.

**Fix.** `await this.bunServer.stop()`; optionally expose a `force` flag.

### L14 — the native fast path bypasses `setErrorHandler()`

`runRouteChain()` (slow path) routes a handler error through
`this.errorHandler` when one is registered. `invokeSingle()` /
`runBunRouteChain()` (fast path) go straight to `res._reject(err)`. Nest
registers an error handler during `init()`, so this is a genuine fast-path vs
slow-path divergence — the same class the previous audit's cross-cutting
recommendation was written to prevent. Low impact only because Nest's own
router proxy catches almost everything before it escapes.

---

## Part 3 — Bun 1.4.x changelog, mapped onto this adapter

CI pins **1.4.0**; the current release is **1.4.2** (2026-09-05).

**1.4.0** (already exploited): `{ dir }` routes with `sendfile`,
`Content-Type` / `ETag` / `Last-Modified` / `304` / `Range` handled natively —
this is what `useStaticAssets({ native: true })` rides on. Also landed:
native `ReadableStream`/`CompressionStream`, automatic backpressure on
streamed response bodies, 13-48 % lower HTTP-server memory.

**1.4.1** — four fixes land directly on adapter surface:

* *"handlers returning promises that never settle leaving requests in
  `server.pendingRequests`"* — same class as H1, though the fix is counter
  bookkeeping, not a runtime timeout for such handlers. Worth re-running the H1
  regression suite on 1.4.1+.
* *multiple `server.upgrade()` bugs (connection handling, microtask execution)*
  — the shared-port WS path calls `server.upgrade()` from inside both
  dispatchers; these fixes are relevant to it.
* *malformed `Range` header acceptance* and *`Bun.file().slice()` sending
  incorrect bytes* — both on the native static path.
* `Bun.serve` gained **HTTP/2 on the same port** via `http2: true`
  (WebSockets not yet supported over it).

**1.4.2** — fixes an **`AsyncLocalStorage` memory leak** regression from 1.4.1.
ALS is what CLS and tracing integrations (`nestjs-cls`, OpenTelemetry, pino's
async context) sit on, so this one matters for long-running apps. (Nest's own
request-scoped providers use `ContextIdFactory`, not ALS — they are unaffected.)

**Recommendation:** add 1.4.2 to the CI matrix alongside the pinned 1.4.0, and
re-run `_probe` H6 there before filing upstream.

---

## Part 4 — Bun capabilities the adapter does not use yet

All verified present on the installed Bun 1.4.0.

**Server options never surfaced** (`Bun.serve`, `bun-types/serve.d.ts:672-774`):

| Option | Why it matters here |
|---|---|
| `idleTimeout` | **H4** — 10 s default silently kills SSE; capped at 255 s, so it is a mitigation for slow uploads, not the SSE fix |
| `maxRequestBodySize` | 128 MB default; the *only* real pre-buffer guard available for **M6** uploads |
| `reusePort` | multi-process scaling (`SO_REUSEPORT`) — the cheapest throughput win the adapter could offer |
| `ipv6Only`, `development` | completeness |
| `id` | preserves the server instance across `bun --hot` reloads (`null` disables) |
| `http2: true` | 1.4.1+, same port as HTTP/1.1 |

**Per-request:** `server.timeout(req, seconds)` — the targeted fix for **H4**
without changing the global timeout.

**Cookies:** Bun routes hand back a native `CookieMap` on `req.cookies`
(verified: `cookie: 'a=1; b=2'` → `[['a','1'],['b','2']]`), and `Bun.Cookie` /
`Bun.CookieMap` can serialise `Set-Cookie` — including `Expires`, which **L8**
is missing. Only a partial replacement: signed cookies still need
`parseCookies()`.

**Observability:** `server.pendingRequests`, `server.pendingWebSockets`,
`server.subscriberCount(topic)` — a `@nestjs/terminus`-style health indicator
could expose all three for free. Nothing in the adapter reads them.

**WebSocket options, none of which the adapter exposes** (`serve.d.ts:432-475`):
`perMessageDeflate`, `maxPayloadLength`, `backpressureLimit`,
`closeOnBackpressureLimit`, `idleTimeout`, `sendPings`, `publishToSelf`, plus
the `ping` / `pong` handlers. `sendPings` + `ping`/`pong` are the practical
answer to the dead `__onError` path in **L4**: heartbeats detect a broken peer
that never sends a close frame.

**Compression:** the adapter has **no compression story at all** — no `gzip` /
`br` / `zstd` on any response path. Bun 1.4 ships native `CompressionStream`
(gzip, deflate, deflate-raw, brotli, zstd), so a `content-encoding` negotiation
step in `reply()` would be a small, self-contained addition.

**Also unused:** `routes` accepts a bare `Response` object for a static
endpoint (zero-allocation health checks, `robots.txt`), and `Response.clone()`
now shares body chunks.

---

## Ranked fix order

| # | Finding | Why |
|---|---|---|
| ~~1~~ | ~~**H4** SSE dies at 10 s~~ | **FIXED 2026-09-06** |
| ~~2~~ | ~~**H5** CORS `origin` callback~~ | **FIXED 2026-09-06** |
| ~~3~~ | ~~**M9** 400 on bad JSON~~ / ~~**M2** preflight gate~~ | **both FIXED 2026-09-06** |
| 4 | **H6** invisible mid-stream failure | comment corrected; upstream repro still owed on 1.4.2 |
| ~~5~~ | ~~**M8** static mount chaining~~ / ~~**M7** decode~~ | **both FIXED 2026-09-06** |
| 6 | **L9 / L10 / L11 / L13** (~~L12~~) | **L12 FIXED 2026-09-06**; the rest are each a handful of lines |
| 7 | Part 4 opt-ins (`idleTimeout`, `maxRequestBodySize`, `reusePort`, compression) | feature work, not defects |

**Docs gap:** closed alongside the fixes — `docs/streaming-and-sse.md` now
explains the idle timer and the per-request opt-out, and `docs/http.md`
documents both `origin` function shapes and the synchronous-callback
requirement.

**Cross-cutting:** the previous audit's recommendation held up — the
fast-path/slow-path parameterised specs caught the whole H2/M3/M1 class, and
nothing in that family regressed. The two divergences that remain (**L9**
CORS-after-listen, **L14** error handler) are both *state-transition* cases, not
per-request ones: the existing matrix runs each dispatcher, but never flips an
app from one to the other after `listen()`. Extending the helper to do that
would close the gap mechanically.
