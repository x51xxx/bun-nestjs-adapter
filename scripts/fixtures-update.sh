#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

cd fixtures/nestjs-nest
git fetch origin master
# `fixtures:install` strips the per-integration tsconfig `paths` blocks in the
# working tree, so a plain checkout would abort on those local modifications.
git checkout -- .
git checkout origin/master
echo "==> bumped to $(git rev-parse --short HEAD)"
cd ../..
git add fixtures/nestjs-nest
echo "==> commit the new submodule SHA when you're happy with the test run"
