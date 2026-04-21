# Plan 1 — Skeleton

**Goal**: Three-service Docker Compose stack (`web`, `worker`, `db`) boots cleanly on the Linux home server. All tooling (pnpm, Biome, Vitest, tsc, Prisma) passes on near-zero code. `/healthz` returns 200. A `migrate` one-shot service applies the initial Prisma migration. Other containers on the host are untouched.

**Depends on**: —

## Scope

**In**
- pnpm workspaces layout: `packages/{web,worker,shared}` (no `scheduler` package — merged into `worker`)
- Biome (lint + format), Vitest, TypeScript strict, Prisma — all configured at root
- Prisma schema for `User`, `Job`, `Run`, `RunLog`, `Setting` per spec §5 + users additions; initial migration generated
- Dockerfiles for `web`, `worker` (multi-stage, `node:20-bookworm-slim` — commit to glibc because the SDK bundles a native Claude Code binary)
- `docker-compose.yml`: `db`, `web`, `worker` with healthchecks + `depends_on.condition: service_healthy`
- `docker-compose.migrate.yml` override: one-shot `migrate` service runs `pnpm prisma migrate deploy` and exits
- Stub `worker` that logs "booted", verifies `/root/.claude` is RW-mounted and writable, registers SIGTERM, idles
- Next.js app serving a static "re-news" page at `/` and `{ok:true}` at `/healthz`
- `.env.example`, root `README.md` pointing at `CLAUDE.md` and `plans/`
- `Makefile` with: `up`, `down`, `migrate`, `logs`, `psql`, `shell-web`, `shell-worker`

**Out**
- Any API routes, pipeline code, CRUD, auth, real tests, CI. Just bones.

## Tasks

1. `pnpm init`; `pnpm-workspace.yaml` with `packages: ["packages/*"]`
2. Root `package.json` scripts: `lint`, `lint:fix`, `typecheck`, `test`, `build`, `dev`, `prisma:migrate`, `prisma:generate`, `format`
3. Root devDeps: `typescript`, `@biomejs/biome`, `vitest`, `prisma`, `@types/node`
4. `tsconfig.base.json` (strict, `NodeNext`, `ES2022`); per-package `tsconfig.json` extending it
5. `biome.json` — format + lint, 2-space, single-quote, line width 100
6. `vitest.config.ts` — workspace-aware
7. `packages/shared/src/index.ts` — exports `prisma` (PrismaClient singleton) and `logger` stub
8. `prisma/schema.prisma` — all models defined now (plan 2 uses Users, plan 4 uses research_raw, etc.). Indexes on `Run.jobId`, `Run.status`, `Run.heartbeatAt`, `RunLog.runId`. Key columns:
   - `User`: id, email (unique), passwordHash, isAdmin, createdAt, updatedAt
   - `Job`: per spec §5 + `userId` FK (`onDelete: Cascade`) + `minIntervalMinutes?`
   - `Run`: per spec §5 + `stage2Json jsonb?` + `renderedOutput text?` (split from `newsletter_output`)
   - `RunLog`, `Setting`: per spec §5
9. `pnpm prisma migrate dev --name init` (generates client + migration dir)
10. `packages/worker/src/index.ts` — logs "worker booted"; on boot, verify `/root/.claude` exists + writable (touch/rm a probe file), log result; register SIGTERM/SIGINT; idle
11. `packages/web` — `create-next-app` (App Router, TS, no Tailwind yet); root page shows "re-news"; `app/healthz/route.ts` returns `{ ok: true, version: process.env.APP_VERSION ?? 'dev' }`
12. Dockerfiles (multi-stage; `node:20-bookworm-slim` base; install pnpm; copy monorepo; `pnpm install --frozen-lockfile`; build; run)
13. `docker-compose.yml`:
    - `name: re-news`
    - services: `db` (postgres:16-alpine with healthcheck `pg_isready`), `web`, `worker`
    - `db` has a `healthcheck`; `web` and `worker` declare `depends_on: db: {condition: service_healthy}`
    - network: `renews_net` (bridge)
    - `container_name` on each: `renews_db`, `renews_web`, `renews_worker`
    - `web` ports: `3100:3000`
    - `worker` volumes: `${HOME}/.claude:/root/.claude` (RW), `./data/runs:/app/data/runs`
    - `db` volume: `./data/postgres:/var/lib/postgresql/data`
    - env on `worker`: `CLAUDE_CODE_USE_SUBSCRIPTION=1`
    - **no** `ANTHROPIC_API_KEY` anywhere
    - **no** `TZ` override anywhere
    - `labels: ["com.centurylinklabs.watchtower.enable=true"]` on `web`, `worker` only (not `db`)
    - per-service `mem_limit` + `cpus`: web 512M/1cpu, worker 2G/2cpu, db 512M/0.5cpu
    - no `network_mode: host`
14. `docker-compose.migrate.yml`:
    - `migrate` service using the same web image, command: `pnpm prisma migrate deploy`, depends on db, `restart: "no"`, no Watchtower label
15. `.env.example`: `DB_PASSWORD`, `COMPOSE_PROJECT_NAME=re-news`, `SESSION_PASSWORD` (32+ char random — iron-session), `GMAIL_USER`, `GMAIL_APP_PASSWORD` (unused until plan 5), placeholders `ADMIN_EMAIL` (first-setup hint only; no env-seeded admin)
16. `Makefile`: `up` (compose up -d), `down`, `migrate` (runs compose -f ... -f docker-compose.migrate.yml run --rm migrate), `logs`, `psql`, `shell-web`, `shell-worker`, `backup` (stub; plan 8 fills in)
17. `README.md` at repo root: one paragraph + links to `CLAUDE.md` and `plans/README.md`

## Acceptance criteria

- [x] `pnpm install` on Linux server succeeds; `pnpm-lock.yaml` committed
- [x] `pnpm lint && pnpm typecheck && pnpm test` all exit 0
- [x] `pnpm --filter @renews/web build` succeeds
- [x] `make migrate` applies the initial migration (starts from empty DB, exits 0, `\dt` lists `users`, `jobs`, `runs`, `run_logs`, `settings`)
- [x] `make up` brings all 3 app containers Up; `docker compose -p re-news ps` shows `db` healthy before `web`/`worker` start
- [x] `docker compose -p re-news logs worker` contains a line confirming `/root/.claude` is mounted and writable
- [x] `curl -sf http://<server-ip>:3100` returns HTML containing "re-news"
- [x] `curl -sf http://<server-ip>:3100/healthz` returns `{"ok":true,...}`
- [x] `docker ps --format '{{.Names}}' | grep -v '^renews_'` lists the user's pre-existing containers, same uptime as before
- [x] `docker network ls | grep renews_net` exists; no other networks touched
- [x] Existing Watchtower container now watches `renews_web/worker` (labels picked up); other watched containers unchanged

## Verification

```bash
# From Linux home server, repo root
pnpm install
pnpm lint && pnpm typecheck && pnpm test
make migrate
make up
docker compose -p re-news ps
sleep 5
docker compose -p re-news logs --tail=30 web worker
curl -sf http://localhost:3100 | grep -q "re-news" && echo "WEB OK"
curl -sf http://localhost:3100/healthz | grep -q '"ok":true' && echo "HEALTH OK"
docker compose -p re-news exec worker ls -la /root/.claude | head
docker compose -p re-news exec worker sh -c 'touch /root/.claude/.renews-write-test && rm /root/.claude/.renews-write-test && echo RW_OK'
# Isolation check — replace <other-container> with one of the user's existing containers
docker inspect <other-container> --format '{{.State.StartedAt}}'  # unchanged
# Tables present
docker compose -p re-news exec db psql -U newsletter -d newsletter -c '\dt'
```

## Notes / gotchas

- `node:20-bookworm-slim` (not alpine) — SDK ships a native Claude Code binary; musl is a known compat risk. Committing upfront saves an iteration.
- Worker runs as root in v1 so `/root/.claude` perms are trivial. Revisit UID hardening post-v1 if needed.
- Port 3100 dodges the common 3000 conflict. If the server has something else there, the Up will fail — adjust.
- `db` deliberately does **not** carry the Watchtower label. We never auto-update data services.
- `plans/` and any `data/` dirs must be in `.gitignore` — confirm before any commit.
- All models are defined in the initial Prisma migration so later plans add data, not schema changes (except where explicitly noted, like adding `stage2Json` use — the column already exists).
