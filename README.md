# re-news

Self-hosted, family-scale newsletter agent. Users define "jobs" (sources + topic + prompt + cron schedule + recipient email); on each fire, a two-agent pipeline researches the web, summarizes to structured JSON, renders markdown/HTML/JSON, and emails via Gmail SMTP. A web UI manages jobs and runs with a live log tail.

Built for 3–4 users and ≤10 runs/day on a single home server, sharing one Claude Pro/Max subscription.

## Status

v1 is feature-complete. All 8 implementation plans have shipped:

- **Skeleton** — monorepo, 3-service Docker Compose, Prisma schema, `/healthz`
- **Auth + Jobs CRUD** — iron-session, `/setup` first-run flow, per-user ownership
- **Worker loop** — embedded node-cron + 5s DB poll, heartbeat + stale-run recovery
- **Research agent** — Stage 1 via Claude Agent SDK (tools enabled), writes `research.json`
- **Summary + render + email** — Stage 2 strict JSON + zod validation + 1 retry, Gmail SMTP
- **Run detail UI** — `/runs/:id` with SSE log tail, sandboxed HTML preview, resend, re-run
- **Hardening** — rate-limit defer, retry w/ backoff, monthly budget, min interval, failure-notice email
- **Deploy + polish** — GHA → GHCR → Watchtower; cron collision hints; AccountInfo badge; token/cost chips; formatted errors; nightly `pg_dump` backups; 30-day run-dir cleanup

Architecture, non-obvious constraints, and the Decisions Log are documented in [`CLAUDE.md`](./CLAUDE.md) and [`plans/README.md`](./plans/README.md).

## Architecture

Three Docker services, no external queue or broker:

```
web     Next.js 14 App Router (UI + API + session auth)  →  port 3100
worker  Long-running node process (node-cron + 5s poll, runs the pipeline)
db      Postgres 16 (single source of truth, incl. the queue)
```

- Monorepo: `packages/{web,worker,shared}`, pnpm workspaces
- Prisma schema at the root; one-shot `migrate` service for `prisma migrate deploy`
- Postgres-backed queue (polling) instead of Redis/BullMQ — family scale doesn't warrant the extra service
- Per-run scratch at `./data/runs/<runId>/` (bind-mounted into worker)
- `./data:/app/data:ro` on `web` so the Settings page can read worker-written `account_info.json`

**Auth model.** Users log into our app (iron-session cookies) and see only their own jobs and runs. Under the hood, the worker uses a single Claude Pro/Max subscription by mounting the admin's `~/.claude` into the worker container. Users never touch Claude credentials — Anthropic's policy against re-offering Claude login through a product is satisfied.

**Email.** Gmail SMTP via Nodemailer (shared admin-owned sender). Resend and every other reputable provider refuses free-email sender domains; Gmail caps at ~500/day/account, which is plenty at this scale.

## Quick start (dev)

```sh
cp .env.example .env        # fill in DB_PASSWORD + SESSION_PASSWORD (≥32 chars)
pnpm install
make migrate                # prisma migrate deploy via one-shot service
make up                     # docker compose up -d
# open http://localhost:3100 — first visitor is redirected to /setup to create the admin
```

Configure Gmail sender + default models at `/settings` (admin-only) after creating the first user.

### Common commands

```sh
make up / make down           # start / stop the stack
make migrate                  # apply new Prisma migrations
make logs                     # tail all service logs
make psql                     # psql shell into the db container
make shell-web / shell-worker # exec into a container
make backup                   # one-shot pg_dump to ./data/backups/
pnpm lint / typecheck / test  # quality gates — all three must pass
```

After changes to `@renews/shared`, run `pnpm --filter @renews/shared build` before building or typechecking `@renews/web` (web consumes the emitted `dist/`).

## Deploy

Images are built on every push to `main` by `.github/workflows/build-and-push.yml` and published to GHCR:

```
ghcr.io/squadrone61/re-news-web:{latest,main,sha-<sha>}
ghcr.io/squadrone61/re-news-worker:{latest,main,sha-<sha>}
```

The home server's existing Watchtower picks them up via the `com.centurylinklabs.watchtower.enable=true` label on `renews_web` / `renews_worker`. **`renews_db` is never labeled** — data services must not auto-update.

Watchtower must run in label-scoped mode (`WATCHTOWER_LABEL_ENABLE=true`) so only our two services are touched. Verify before first deploy:

```sh
docker inspect <watchtower> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -i LABEL
docker ps --filter "label=com.centurylinklabs.watchtower.enable" --format '{{.Names}}'
```

If `WATCHTOWER_LABEL_ENABLE` is unset, either (a) label the currently-watched containers explicitly and flip the env var, or (b) accept that other `:latest` containers will also auto-update. Recommended poll interval: `WATCHTOWER_POLL_INTERVAL=300` (5 min).

### First deploy

```sh
git clone https://github.com/squadrone61/re-news.git && cd re-news
cp .env.example .env && $EDITOR .env       # DB_PASSWORD, SESSION_PASSWORD (≥32 chars)
chmod 600 .env
make migrate
docker compose -p re-news -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -p re-news -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Mark the GHCR packages **public** (GitHub → Packages → each → Visibility → Public) so Watchtower can pull anonymously.

### Updates

Push to `main`. GH Actions builds both images (< 10 min), Watchtower rolls `web` + `worker` on its next poll; `db` is left alone. If a release carries a new Prisma migration, run `make migrate` **before** Watchtower picks up the new images — migrations are deliberately not in the container CMDs (parallel boots would race).

### Rollback

Temporarily pin to an older SHA tag in `docker-compose.prod.yml`:

```yaml
services:
  web:
    image: ghcr.io/squadrone61/re-news-web:sha-<oldsha>
  worker:
    image: ghcr.io/squadrone61/re-news-worker:sha-<oldsha>
```

Then `pull && up -d`. Remove the override to resume `:latest`.

### Backups

A profile-gated `backup` service (`docker-compose.backup.yml`) dumps Postgres to `./data/backups/YYYY-MM-DD.sql.gz` and prunes files older than 14 days. It does not run on `make up`. Trigger via host crontab:

```cron
0 2 * * *  cd /path/to/re-news && docker compose -p re-news -f docker-compose.yml -f docker-compose.backup.yml run --rm backup >/dev/null 2>&1
```

Manual: `make backup`. Restore:

```sh
gunzip -c data/backups/2026-04-21.sql.gz \
  | docker compose -p re-news exec -T db psql -U newsletter -d newsletter
```

### Secrets

`.env` lives on the host, `chmod 600`, never committed. Compose reads it automatically. Gmail sender credentials are configured in the UI (`/settings`), stored in the `settings` table — not in env.

## Repository layout

```
packages/
  shared/      # Prisma client singleton, zod schemas, cron helpers, preflight, logger
  web/         # Next.js App Router: UI + API routes + session auth
  worker/      # node-cron scheduler, poll loop, two-stage pipeline, cleanup, account-info
prisma/        # schema.prisma + migrations
data/          # host-side state (gitignored): postgres, per-run scratch, backups, account_info.json
.github/       # GH Actions: build-and-push to GHCR
docker-compose.yml          # web, worker, db
docker-compose.migrate.yml  # one-shot prisma migrate deploy
docker-compose.prod.yml     # overrides build: with ghcr.io images + pull_policy: always
docker-compose.backup.yml   # profile-gated pg_dump + 14-day prune
```
