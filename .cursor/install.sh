#!/usr/bin/env bash
# Idempotent bootstrap for the rapbattle Cloudflare Worker dev environment.
set -euo pipefail
cd "$(dirname "$0")/.."

# Exact, lockfile-pinned dependencies (mirrors the typecheck CI workflow).
npm ci

# The Worker's ensureSchema() (src/beats.ts) only ALTERs the base tables and
# creates the auxiliary ones at runtime; the base tables themselves come from
# src/db/schema.sql. Seed them into the local (miniflare) D1 that
# `wrangler dev --local` uses so the arena has real tables on first boot.
# CREATE TABLE IF NOT EXISTS keeps this safe to re-run.
npx wrangler d1 execute rapbattle --local --file=./src/db/schema.sql

# Local-only secret that unlocks the /admin/* seed + repair routes
# (see src/admin.ts). It never touches production: .dev.vars is git-ignored and
# only read by `wrangler dev`. Without it the app still runs; you just can't use
# the one-shot arena seeder.
if [ ! -f .dev.vars ]; then
  cat > .dev.vars <<'EOF'
# Local development secrets for `wrangler dev` only. Git-ignored, non-production.
ADMIN_SECRET="local-dev-secret"
EOF
fi
