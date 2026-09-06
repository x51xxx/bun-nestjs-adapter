# HTTP

## Routing and the fast path

At `app.listen()` the adapter inspects what features are active. When **no
adapter-level middleware, static-asset mount, or CORS** is configured, it hands
the whole route table to Bun's native C++ matcher via `Bun.serve({ routes })`
(the *fast path*). Otherwise it falls back to a manual `fetch` dispatcher that
does its own matching and `next()`-style middleware chaining.

Both paths support every verb (`GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS/ALL` plus
`SEARCH`), route params (`:id`), and wildcards.

> Routes registered **after** `app.listen()` (e.g. via `LazyModuleLoader`) are
> picked up: the adapter rebuilds the route map and calls
> `server.reload({ routes })`. See [Architecture](./architecture.md) and
> [`KNOWN-LIMITATIONS.md`](../KNOWN-LIMITATIONS.md).

## Body parsing

JSON, URL-encoded, and text bodies are parsed automatically for
`POST/PUT/PATCH`. The JSON path hands the request bytes straight to Bun's native
parser — no intermediate `Buffer`/string — unless you opt into the raw body.

- `application/json` → parsed object on `req.body`
- `application/x-www-form-urlencoded` → object on `req.body`
- `text/*` → string on `req.body`
- `multipart/*` → left untouched for upload interceptors to read via
  `req.bunRequest.formData()` (see [File uploads](./file-uploads.md))

A body that claims `application/json` and doesn't parse is answered with **400
Bad Request** before the handler runs — the same thing `body-parser` does on
platform-express — rather than handing the handler `undefined` and surfacing as
a confusing validation error later. Only JSON is policed this way; a `text/*`
body is whatever bytes arrived.

**Raw body:** create the app with `{ rawBody: true }` to also get `req.rawBody`
(a `Buffer`) — useful for webhook signature verification. `req.rawBody` is
populated even for a payload that fails to parse, though the request still ends
in a 400. **No body parsing:** `{ bodyParser: false }` skips parsing entirely,
malformed JSON included.

## Versioning

All four Nest versioning strategies work — URI, HEADER, MEDIA_TYPE, and CUSTOM —
including multi-match dispatch where several handlers share a path and are
disambiguated by version. `applyVersionFilter` is implemented for each strategy.

```ts
app.enableVersioning({ type: VersioningType.URI });
```

## CORS

```ts
app.enableCors({ origin: 'https://example.com', credentials: true });
```

Enabling CORS routes requests through the manual dispatcher (it can't be modelled
by the native `routes` map), so it disables the fast path.

Every `OPTIONS` request is treated as a preflight and answered before dispatch —
the same rule `cors` (which `@nestjs/platform-express` uses) and `@fastify/cors`
apply; neither sniffs `Access-Control-Request-Method`. To own `OPTIONS` yourself,
use `preflightContinue`, which applies the preflight headers and then falls
through to normal routing:

```ts
app.enableCors({ origin: true, preflightContinue: true });

@Options('thing')
thing() {
  return { handled: 'by the controller' };
}
```

`optionsSuccessStatus` picks the status for a preflight the adapter ends itself
(`204` by default; `200` is the usual workaround for legacy browsers).

Which headers go out depends on the kind of request, again matching `cors`:

| header | preflight | actual response |
| --- | --- | --- |
| `Access-Control-Allow-Origin` | ✔ | ✔ |
| `Access-Control-Allow-Credentials` | ✔ | ✔ |
| `Access-Control-Expose-Headers` | ✔ | ✔ |
| `Access-Control-Allow-Methods` | ✔ | — |
| `Access-Control-Allow-Headers` | ✔ | — |
| `Access-Control-Max-Age` | ✔ | — |

The bottom three describe a *future* request, so they only mean anything on a
preflight.

`origin` accepts a string, `true`, a `RegExp`, an array of either, or a function
in one of two shapes — told apart by how many parameters it declares:

```ts
// The `cors`-package contract, as shown in the Nest docs.
app.enableCors({
  origin: (requestOrigin, callback) => callback(null, allowlist.has(requestOrigin)),
});

// This adapter's shorter form: the whole request shim, returning the value.
// Annotate the parameter — TypeScript can't infer it out of a union of
// function types whose arities differ.
app.enableCors({ origin: (req: BunRequest) => req.headers['x-tenant'] === 'acme' });
```

The callback must be invoked **synchronously** — the header has to be set before
dispatch, so an async lookup can't be awaited. A function that calls back later
emits no `Access-Control-Allow-Origin` and logs a warning once.

## Static assets

```ts
app.useStaticAssets(join(import.meta.dir, 'public'), {
  prefix: '/static',
  index: 'index.html',
});
```

Served with `Bun.file()` (zero-copy where the OS allows). `prefix` and `index`
are optional. Like CORS, a static mount uses the manual dispatcher.

Several roots can share a prefix. They are tried in registration order and the
first one holding the file wins; when they all miss, the request carries on to
route dispatch — the same chaining `serve-static` gets from `next()`:

```ts
app.useStaticAssets(join(import.meta.dir, 'overrides'), { prefix: '/static' });
app.useStaticAssets(join(import.meta.dir, 'public'), { prefix: '/static' });
```

The URL suffix is percent-decoded one segment at a time before it reaches the
filesystem, so `/static/my%20file.txt` serves `my file.txt`. The same pass is
the traversal guard: a segment that decodes to `.`, `..`, nothing at all, or
that hides a separator (`%2F`, `%5C`) or a `%00` is rejected with `403` rather
than resolved. Bun resolves plain dot-segments in `Request.url` before the
adapter is called at all, so `/static/%2e%2e/x` never reaches the mount; the
guard covers what Bun passes through untouched. Both mount modes decode
identically; they differ only in the status for a rejected path (`403` classic,
`404` native, matching Bun's own directory route).

Responses carry a weak `ETag` and `Last-Modified`, and a conditional request
(`If-None-Match` / `If-Modified-Since`) is answered with `304`. On Bun >= 1.4.0
a `Range` request comes back as `206` — Bun handles that for a `Bun.file` body
itself.

### `native: true` (Bun >= 1.4.0)

```ts
app.useStaticAssets(join(import.meta.dir, 'public'), {
  prefix: '/static',
  native: true,
});
```

Bun 1.4.0 added directory routes (`{ '/static/*': { dir } }`), so a static mount
can live **on the native route map** instead of forcing the whole app onto the
manual dispatcher. Measured locally (k6, 50 VUs, both orders): serving the files
themselves goes from ~18.6k to ~35–40k RPS, and ordinary API routes in the same
app gain ~3% because they get the fast path back.

Caching behaves the same in both modes — one `ETag` formula, so switching a
mount from classic to native does not invalidate what clients already hold. It
is opt-in because the *routing* semantics are not the same:

| | classic | `native: true` |
| --- | --- | --- |
| order | static is tried **before** routes | routes match **first**; the directory answers what is left |
| miss under the prefix | falls through to route dispatch, ends in Nest's JSON 404 | hard `404` with an empty body — Nest's not-found handler never runs |
| methods | `GET` / `HEAD` only | any method returns the file |
| directory without a trailing slash | serves `index` | `301` to the trailing-slash URL |

Both dispatchers are covered by `tests/integration/static-native.spec.ts`, which
runs the same table against a clean app (native routes) and one with middleware
(manual dispatcher). One divergence is out of the adapter's hands and is
asserted there rather than hidden: Bun resolves dot-segments in `Request.url`
before the `fetch` callback runs, so `/static/sub/%2e%2e/data.json` is a `404`
natively and a collapsed `200` on the manual dispatcher. Nothing outside `root`
is reachable on either path.

If a Nest route already owns the `/prefix/*` key (e.g. `@Get('assets/*')`), the
route keeps it and the directory answers only the methods the route does not
declare — the same on both dispatchers. A mount registered after `listen()`
rebuilds the live route map, so it takes effect immediately.

On Bun < 1.4.0 the flag logs a warning and falls back to the classic mount.

## The `req` / `res` shims

Handlers receive Express-flavoured `req`/`res` objects built over the Web
`Request`:

- `req`: `method`, `url`, `originalUrl`, `path`, `params`, `query`, `headers`,
  `hostname`, `ip`, `get(name)` / `header(name)`, and an `EventEmitter` surface
  (`on('close', …)` bridges Bun's `AbortSignal`). The untouched Web `Request` is
  exposed as `req.bunRequest`.
- `res`: `status()`, `send()`, `json()`, `end()`, `redirect()`, `set()` /
  `header()`, `type()`. The response is **buffered** and resolved into a single
  Web `Response`; it transparently upgrades to a streaming response the first
  time you `write()` (see [Streaming & SSE](./streaming-and-sse.md)).

These shims cover the common Express surface Nest core relies on; they are not a
complete Express implementation.

Next: [Streaming & SSE →](./streaming-and-sse.md)
