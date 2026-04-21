# re-news

Self-hosted, family-scale newsletter agent.

See [`CLAUDE.md`](./CLAUDE.md) for architecture and constraints, and [`plans/README.md`](./plans/README.md) for the 8-plan build order.

## Quick start (dev)

```sh
cp .env.example .env        # fill in DB_PASSWORD + SESSION_PASSWORD
pnpm install
make migrate
make up
# http://localhost:3100
```

## Deploy

Images are built on every push to `main` by `.github/workflows/build-and-push.yml` and published to GHCR as:

```
ghcr.io/squadrone61/re-news-web:{latest,main,sha-<sha>}
ghcr.io/squadrone61/re-news-worker:{latest,main,sha-<sha>}
```

The home server's existing Watchtower picks them up via the `com.centurylinklabs.watchtower.enable=true` label on `renews_web` / `renews_worker`. **`renews_db` is never labeled** — data services must not auto-update.

Watchtower must be running in label-scoped mode (`WATCHTOWER_LABEL_ENABLE=true`) so only labeled containers are touched. Verify before first deploy:

```sh
docker inspect <watchtower> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -i LABEL
docker ps --filter "label=com.centurylinklabs.watchtower.enable" --format '{{.Names}}'
```

If `WATCHTOWER_LABEL_ENABLE` is unset, Watchtower watches everything. Either (a) label the currently-watched containers explicitly and flip `WATCHTOWER_LABEL_ENABLE=true`, or (b) accept that other containers will also auto-update on `:latest`. Plan 8 prefers (a). Recommended poll interval: `WATCHTOWER_POLL_INTERVAL=300` (5 min).

### First deploy

```sh
git clone https://github.com/squadrone61/re-news.git && cd re-news
cp .env.example .env && $EDITOR .env       # DB_PASSWORD, SESSION_PASSWORD (≥32 chars)
chmod 600 .env
make migrate                                # applies schema; no app images needed yet
docker compose -p re-news -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -p re-news -f docker-compose.yml -f docker-compose.prod.yml up -d
# visit http://<host>:3100 — first visitor is redirected to /setup to create the admin
```

Mark the GHCR packages **public** (GitHub → Packages → each image → Package settings → Visibility → Public) so Watchtower can pull anonymously.

### Updates

Push to `main`. GH Actions builds both images (< 10 min), Watchtower rolls `web` and `worker` within its poll interval. `db` is left alone. If a release carries a new Prisma migration, run `make migrate` **before** Watchtower picks up the images:

```sh
git pull
make migrate
# Watchtower will now pull the new :latest tags on its next poll
```

### Rollback

Pin to a specific SHA tag:

```yaml
# docker-compose.prod.yml (temporary override)
services:
  web:
    image: ghcr.io/squadrone61/re-news-web:sha-<oldsha>
  worker:
    image: ghcr.io/squadrone61/re-news-worker:sha-<oldsha>
```

```sh
docker compose -p re-news -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -p re-news -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Remove the SHA override to resume `:latest`.

### Backups

A nightly `backup` one-shot service dumps Postgres to `./data/backups/YYYY-MM-DD.sql.gz` and prunes anything older than 14 days. Trigger it via host crontab:

```cron
0 2 * * *  cd /path/to/re-news && docker compose -p re-news -f docker-compose.yml -f docker-compose.backup.yml run --rm backup >/dev/null 2>&1
```

Manual run: `make backup`. Restore:

```sh
gunzip -c data/backups/2026-04-21.sql.gz \
  | docker compose -p re-news exec -T db psql -U newsletter -d newsletter
```

### Secrets

`.env` lives on the host, `chmod 600`, never committed. Compose reads it automatically. Gmail sender creds are configured in the UI (`/settings`), stored in the `settings` table — not in env.
