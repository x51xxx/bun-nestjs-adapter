#!/usr/bin/env bash
# Install the upstream nestjs/nest submodule and its node_modules so that our
# tests can require integration fixtures (`integration/hello-world/src`,
# `integration/versioning/src`, etc) directly from there.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .gitmodules ]]; then
  echo "==> registering nestjs/nest submodule (pinned)"
  git submodule add https://github.com/nestjs/nest.git fixtures/nestjs-nest
fi

echo "==> updating submodule"
git submodule update --init --recursive --depth 1 fixtures/nestjs-nest

cd fixtures/nestjs-nest
echo "==> installing nestjs/nest deps (legacy peer deps required)"
# Upstream master's package-lock.json regularly lags its package.json, which
# makes `npm ci` bail with EUSAGE. Fall back to a plain install in that case.
npm ci --legacy-peer-deps --no-audit --no-fund \
  || npm install --legacy-peer-deps --no-audit --no-fund
echo "==> building nestjs packages"
npm run build

# nest v12 turned the monorepo into npm workspaces, so `node_modules/@nestjs/*`
# are now symlinks back into `packages/*`, where the .ts sources sit next to the
# build output. Our tsconfig `paths` redirect then resolves `@nestjs/common` to
# `index.ts` instead of `index.d.ts` and tsc trips on upstream's type-only
# re-exports under `isolatedModules`. Drop the links and re-run upstream's own
# copy task so node_modules/@nestjs/* holds only .js/.d.ts/package.json again.
echo "==> replacing workspace symlinks with built output"
find node_modules/@nestjs -maxdepth 1 -type l -delete
npm run move:node_modules

# Strip the per-integration `paths` blocks from the working copy so Bun
# doesn't redirect `@nestjs/*` imports back to the upstream TypeScript
# sources (where its per-file transpiler trips on type-only re-exports).
# We resolve through the freshly built `node_modules/@nestjs/*` instead.
# The submodule SHA is unaffected — only the working tree changes.
echo "==> stripping tsconfig paths from upstream integration dirs + root"
python3 - <<'PY'
import re, glob
patched = 0
candidates = glob.glob('integration/**/tsconfig.json', recursive=True) + [
    'tsconfig.json',
    'tsconfig.spec.json',
]
for path in candidates:
    try:
        with open(path) as f: txt = f.read()
    except FileNotFoundError:
        continue
    new = re.sub(r',?\s*"paths"\s*:\s*\{[^}]*\}', '', txt)
    if new != txt:
        with open(path, 'w') as f: f.write(new)
        patched += 1
print(f"patched {patched} files")
PY

echo "✅ fixtures ready"
