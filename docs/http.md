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

**Raw body:** create the app with `{ rawBody: true }` to also get `req.rawBody`
(a `Buffer`) — useful for webhook signature verification. **No body parsing:**
`{ bodyParser: false }` skips parsing entirely.

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

## Static assets

```ts
app.useStaticAssets(join(import.meta.dir, 'public'), {
  prefix: '/static',
  index: 'index.html',
});
```

Served with `Bun.file()` (zero-copy where the OS allows). `prefix` and `index`
are optional. Like CORS, a static mount uses the manual dispatcher.

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

It is opt-in because the semantics are not the same as the classic mount:

| | classic | `native: true` |
| --- | --- | --- |
| order | static is tried **before** routes | routes match **first**; the directory answers what is left |
| miss under the prefix | falls through to route dispatch, ends in Nest's JSON 404 | hard `404` with an empty body — Nest's not-found handler never runs |
| methods | `GET` / `HEAD` only | any method returns the file |
| directory without a trailing slash | serves `index` | `301` to the trailing-slash URL |
| validators | none | weak `ETag`, `Last-Modified`, `304` on `If-None-Match` / `If-Modified-Since` |
| `Range` | 206 (Bun 1.4.0+ handles it for `Bun.file` bodies) | 206 |

Both dispatchers are covered by `tests/integration/static-native.spec.ts`, which
runs the same table against a clean app (native routes) and one with middleware
(manual dispatcher). One divergence is out of the adapter's hands and is
asserted there rather than hidden: Bun resolves dot-segments in `Request.url`
before the `fetch` callback runs, so `/static/sub/%2e%2e/data.json` is a `404`
natively and a collapsed `200` on the manual dispatcher. Nothing outside `root`
is reachable on either path.

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
