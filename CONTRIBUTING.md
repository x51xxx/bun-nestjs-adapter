# Contributing

## Prerequisites

- Bun ≥ 1.3.0 (`curl -fsSL https://bun.com/install | bash`)
- Node ≥ 20 (only required for the upstream-fixtures install — Bun runs
  everything else)

## Setup

```bash
git clone https://github.com/USER/bun-nestjs-adapter.git
cd bun-nestjs-adapter
bun install
bun run fixtures:install   # optional but recommended
```

## Workflow

```bash
bun run typecheck
bun run lint
bun run test
bun run bench:quick
```

## Commit style

Conventional Commits (`feat`, `fix`, `chore`, `docs`, `test`, `perf`, …),
enforced by `commitlint` via Husky. Keep the subject ≤ 70 chars.

Examples:

```
feat(adapter): support shared-port websocket upgrade
fix(file-interceptor): skip body parser for multipart payloads
perf(adapter): drop Headers proxy in favour of eager copy
```

## Releasing

We use [`changesets`](https://github.com/changesets/changesets):

```bash
bun x changeset            # describe your change
git commit -am "chore: changeset"
```

Merging to `main` triggers the release workflow which opens a "version
packages" PR. Merging that PR publishes to npm.

## Updating the upstream Nest fixtures

```bash
bun run fixtures:update    # fetch + checkout origin/master
bun run test:fixtures      # confirm everything still passes
git commit -am "test: bump nest fixtures to <SHA>"
```
