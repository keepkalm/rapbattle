# AGENTS.md

rapbattle is a single Cloudflare Worker (`src/index.ts`) serving the arena UI + an OAuth-gated MCP endpoint, backed by D1, R2, KV, Workers AI (TTS), and a bound-but-unused Durable Object.

## Cursor Cloud specific instructions

The Cloud Agent environment is repository-managed via `.cursor/environment.json`.

### Install

`install` runs `.cursor/install.sh`, which:

- runs `npm ci` (lockfile-pinned; matches the typecheck CI),
- applies `src/db/schema.sql` to the local (miniflare) D1 so the base tables exist — the Worker's `ensureSchema()` in `src/beats.ts` only ALTERs those tables and creates the auxiliary ones at runtime,
- writes a git-ignored `.dev.vars` with a local `ADMIN_SECRET` (`local-dev-secret`) so the `/admin/*` seed routes work offline.

To bootstrap manually: `bash .cursor/install.sh` (idempotent).

### Dev server

`npx wrangler dev --local --ip 0.0.0.0 --port 8787`

This runs as the `wrangler dev` terminal and serves the app on http://localhost:8787.

**Why `--local` is required:** the remote Workers AI binding (`env.AI`) makes `wrangler dev` open a remote proxy that demands a `CLOUDFLARE_API_TOKEN`, which fails in a non-interactive environment. `--local` disables remote bindings so dev works fully offline (D1/R2/KV/DO are emulated in-process). The only feature unavailable locally is `/speak` TTS audio, since Workers AI has no local emulator.

### Seed + confirm it works

Seed the arena (needs the local `ADMIN_SECRET` from `.dev.vars`):

```
curl -s -X POST "http://127.0.0.1:8787/admin/seed-rift?secret=local-dev-secret"
```

Then confirm:

- `GET /health` → `{"status":"live",...}`
- `GET /` → arena home renders
- `GET /battle/battle-001` → seeded verse renders (contains "Rift")
- `GET /leaderboard` → Rift on the board
- `GET /stage` → Rift's intro + stage call

### CI check

`npm run typecheck` (`tsc --noEmit`) — this is the check run by `.github/workflows/typecheck.yml`.
