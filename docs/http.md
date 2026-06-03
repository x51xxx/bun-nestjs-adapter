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
