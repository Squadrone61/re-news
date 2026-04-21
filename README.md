# re-news

Self-hosted, family-scale newsletter agent. Users define "jobs" (sources + topic + prompt + cron + recipient email); on each fire, a two-stage Claude pipeline researches the web, summarizes to strict JSON, renders markdown/HTML/JSON, and emails via Gmail SMTP. Web UI manages jobs and runs with a live log tail.

Built for 3–4 users and ≤10 runs/day on a single home server, sharing one Claude Pro/Max subscription.

Architecture details and non-obvious traps live in [`CLAUDE.md`](./CLAUDE.md).

## Architecture

Three Docker services, no external broker:

```
web     Next.js 14 (UI + API + iron-session auth)   →  port 3100
worker  node-cron + 5s DB poll, runs the pipeline
db      Postgres 16 (also acts as the queue)
```

Monorepo: `packages/{web,worker,shared}`, pnpm workspaces. Per-run scratch in `./data/runs/<runId>/`.

**Auth.** Users log into our app (iron-session); each user sees only their own jobs and runs. The worker uses one shared Claude Pro/Max subscription via the admin's `~/.claude` mount — users never touch Claude credentials.

**Email.** Gmail SMTP via Nodemailer, shared admin-owned sender. Resend and other reputable providers reject free-email sender domains; Gmail caps at ~500/day, plenty here.

## Quick start (dev)

```sh
cp .env.example .env        # set DB_PASSWORD + SESSION_PASSWORD (≥32 chars)
pnpm install
make migrate                # prisma migrate deploy via the one-shot service
make up                     # docker compose up -d
# open http://localhost:3100 — first visitor is redirected to /setup
```

Configure Gmail sender + default models at `/settings` (admin-only) after the first user is created.

### Common commands

```sh
make up / make down           # start / stop the stack
make migrate                  # apply new Prisma migrations
make logs                     # tail all service logs
make psql                     # psql shell into the db container
make shell-web / shell-worker # exec into a container
make backup                   # one-shot pg_dump → ./data/backups/
pnpm lint / typecheck / test  # quality gates (all three must pass)
```

After editing `@renews/shared`, run `pnpm --filter @renews/shared build` before web build/typecheck.

## Deploy

GH Actions builds both images on every push to `main` and publishes to GHCR:

```
ghcr.io/squadrone61/re-news-web:{latest,main,sha-<sha>}
ghcr.io/squadrone61/re-news-worker:{latest,main,sha-<sha>}
```

The home server's existing Watchtower picks them up via the `com.centurylinklabs.watchtower.enable=true` label on `renews_web` / `renews_worker`. **`renews_db` is never labeled** — data services must not auto-update.

Watchtower runs in label-scoped mode (`WATCHTOWER_LABEL_ENABLE=true`) so only our two services are touched.

### First deploy

```sh
git clone https://github.com/squadrone61/re-news.git && cd re-news
cp .env.example .env && $EDITOR .env       # DB_PASSWORD, SESSION_PASSWORD
chmod 600 .env
make migrate
docker compose -p re-news -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -p re-news -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Mark the GHCR packages **public** (GitHub → Packages → Visibility) so Watchtower can pull anonymously.

### Updates

Push to `main`. Watchtower rolls `web` + `worker` on its next poll; `db` is left alone. **If a release carries a new Prisma migration, run `make migrate` before Watchtower picks up the new images** — migrations are deliberately not in container CMDs (parallel boots would race).

### Rollback

Pin to an older SHA tag in `docker-compose.prod.yml`:

```yaml
services:
  web:
    image: ghcr.io/squadrone61/re-news-web:sha-<oldsha>
  worker:
    image: ghcr.io/squadrone61/re-news-worker:sha-<oldsha>
```

Then `pull && up -d`. Remove the override to resume `:latest`.

### Backups

Profile-gated `backup` service dumps Postgres to `./data/backups/YYYY-MM-DD.sql.gz` and prunes >14 days. Doesn't run on `make up`. Trigger via host crontab:

```cron
0 2 * * *  cd /path/to/re-news && docker compose -p re-news -f docker-compose.yml -f docker-compose.backup.yml run --rm backup >/dev/null 2>&1
```

Manual: `make backup`. Restore:

```sh
gunzip -c data/backups/2026-04-21.sql.gz \
  | docker compose -p re-news exec -T db psql -U newsletter -d newsletter
```

### Secrets

`.env` lives on the host, `chmod 600`, never committed. Gmail sender credentials are configured in the UI (`/settings`), not in env.

## Repository layout

```
packages/
  shared/      # Prisma client singleton, zod schemas, cron + preflight helpers, logger
  web/         # Next.js App Router: UI + API routes + session auth
  worker/      # node-cron, poll loop, two-stage pipeline, cleanup, account-info
prisma/        # schema.prisma + migrations
data/          # host-side state (gitignored): postgres, per-run scratch, backups
.github/       # GH Actions: build-and-push to GHCR
docker-compose.yml          # web, worker, db
docker-compose.migrate.yml  # one-shot prisma migrate deploy
docker-compose.prod.yml     # ghcr.io images + pull_policy: always
docker-compose.backup.yml   # profile-gated pg_dump + 14-day prune
```
