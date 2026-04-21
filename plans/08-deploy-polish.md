# Plan 8 — Deploy + Polish

**Goal**: GH Actions builds 2 images (`web`, `worker`) on push to `main` and pushes to GHCR. The home server's existing Watchtower picks them up via label and rolls containers, leaving all other containers untouched. Plus the small UX and operational items from the spec that weren't worth a separate plan: cron collision hints, next-5-fires preview, `AccountInfo` badge, token/cost capture, error formatting, run-dir cleanup, nightly pg_dump backups.

**Depends on**: 7

## Scope

**In — Deploy**
- GitHub Actions `.github/workflows/build-and-push.yml` on push to `main`: matrix `[web, worker]`, tags `:latest`, `:main`, `:sha-<sha>`, pushes to `ghcr.io/squadrone61/re-news-<svc>`
- `docker-compose.prod.yml` override replacing `build:` with `image: ghcr.io/...:latest`
- Watchtower alignment (see Tasks — verify label-scope mode or flip it safely)
- README deploy section: first-time, updates, rollback via `:sha-<oldsha>`
- The `docker-compose.migrate.yml` from plan 1 is the migration flow: `make migrate` before a release with a new migration

**In — Polish**
- Cron collision warning in job editor + suggested offsets
- Next-5-fires preview in job editor
- `AccountInfo` badge on Settings page (from SDK; 5-min cached)
- Token/cost totals on run detail, populated from SDK `ModelUsage` where available (`runs.tokensIn`, `tokensOut`, `costUsd`)
- Formatted errors on run detail: known prefixes (`rate_limit:`, `email send:`, `stage2 validation failed`) get an icon + short description + link to README section
- Settings footer: `Server time: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
- Daily cleanup cron (fixed, not user-editable): removes `/app/data/runs/<runId>` for runs with `finishedAt < now - 30 days`; DB rows retained
- Nightly `pg_dump` backup cron to `./data/backups/YYYY-MM-DD.sql.gz`; keeps last 14 days

**Out**
- Staging env, blue-green, canary, feature flags — not needed

## Tasks

### Deploy
1. `/healthz` (already shipped in plan 1). Ensure middleware (plan 2) exempts it — it does
2. `.github/workflows/build-and-push.yml`:
   ```yaml
   name: build-and-push
   on:
     push: { branches: [main] }
   jobs:
     build:
       runs-on: ubuntu-latest
       permissions: { contents: read, packages: write }
       strategy:
         matrix: { svc: [web, worker] }
       steps:
         - uses: actions/checkout@v4
         - uses: docker/setup-buildx-action@v3
         - uses: docker/login-action@v3
           with:
             registry: ghcr.io
             username: ${{ github.actor }}
             password: ${{ secrets.GITHUB_TOKEN }}
         - uses: docker/build-push-action@v5
           with:
             context: .
             file: packages/${{ matrix.svc }}/Dockerfile
             push: true
             tags: |
               ghcr.io/squadrone61/re-news-${{ matrix.svc }}:latest
               ghcr.io/squadrone61/re-news-${{ matrix.svc }}:main
               ghcr.io/squadrone61/re-news-${{ matrix.svc }}:sha-${{ github.sha }}
             cache-from: type=gha
             cache-to: type=gha,mode=max
   ```
3. `docker-compose.prod.yml`:
   ```yaml
   services:
     web:
       image: ghcr.io/squadrone61/re-news-web:latest
       build: !reset null
     worker:
       image: ghcr.io/squadrone61/re-news-worker:latest
       build: !reset null
   ```
   Used: `docker compose -p re-news -f docker-compose.yml -f docker-compose.prod.yml up -d`
4. Watchtower alignment on the server:
   ```bash
   docker inspect <watchtower-container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -i LABEL
   docker ps --filter "label=com.centurylinklabs.watchtower.enable" --format '{{.Names}}'
   ```
   - If `WATCHTOWER_LABEL_ENABLE=true` already → our labels (plan 1) are enough; nothing to do
   - If unset → Watchtower watches everything. Option A (recommended): label existing watched containers explicitly, then set `WATCHTOWER_LABEL_ENABLE=true`, restart Watchtower. Option B: accept the default, rely on `:latest` tag watching — only if other containers' current auto-update behavior is already fine
5. First GHA run: in GitHub → Packages → each image → Visibility → **Public**. Watchtower pulls anonymously; avoids storing a PAT on the server
6. README deploy section:
   - First deploy: clone repo → create `.env` → `make migrate` → `docker compose -f docker-compose.yml -f docker-compose.prod.yml pull && up -d`
   - Updates: push to `main`; Watchtower rolls within poll interval (recommend 300s)
   - Rollback: override the image tag in compose to `:sha-<oldsha>`, `pull && up -d`

### Polish
7. Cron preview endpoint `GET /api/jobs/cron-preview?schedule=...` — returns `{ next5: ISO[], collisions: [{ jobId, name }] }`. Uses `cron-parser` for next-5; queries other enabled jobs (same user) whose next fire minute matches
8. Job editor wires it up: on schedule change, debounce 300ms, call endpoint, render next-5 list and a warning if collisions exist with suggested offsets (`:03`, `:17`, `:37`)
9. `AccountInfo` badge:
   - Worker exposes `GET /internal/account-info` (local only, served on a second port or via a file write that web polls) OR simpler: a shared command — skip the HTTP, have the worker write `/app/data/account_info.json` on boot + every 5 min. Web reads this file via a bind mount to `./data/`. If file missing or stale (>10 min) → show "auth unknown — run `claude` on host"
   - Settings page reads and displays: plan name, tier, last refresh time
10. Token/cost capture in plans 4 + 5:
    - During SDK streaming, if message has `usage` / `model_usage` / similar, accumulate `tokensIn`, `tokensOut`, `costUsd` in memory; persist on each status transition
    - Best-effort: SDK shape may vary, columns are nullable. Don't fail a run if capture fails — log a `sys` warning
    - Run detail header shows `tokensIn / tokensOut / $cost` when present
11. Error formatting on run detail:
    - `ErrorDisplay` component: if `run.error.startsWith('rate_limit:')` → red icon + "Claude rate limit hit. Window resets at <nextRunAt>. Try Re-run after that time."; similar mappings for `email send:` and `stage2 validation failed`
    - Unknown error prefix → fallback to raw string
12. Settings footer: `<p>Server time: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Schedules use this timezone.</p>`
13. Run-dir cleanup: worker registers a daily cron `0 3 * * *` (fixed, not user-visible) that deletes `/app/data/runs/<runId>` for runs with `finishedAt < now - 30 days`. Logs `cleanup: deleted N dirs`
14. Nightly `pg_dump` backup:
    - Approach: a tiny service in `docker-compose.yml` — `backup: image: postgres:16-alpine` running a cron script. Or simpler: worker registers another daily cron `0 2 * * *` that runs `pg_dump` via a shelled-out `docker exec` — no, that's ugly from inside a container
    - Pick: dedicated `backup` one-shot via host crontab (README doc) — simplest and outside the stack. Or a `backup` service in compose with `image: postgres:16-alpine`, mounts `./data/backups:/backups`, command does `pg_dump -h db ... | gzip > /backups/$(date +%F).sql.gz && find /backups -mtime +14 -delete`, scheduled by host cron calling `docker compose -p re-news run --rm backup`
    - Document in README: `0 2 * * * cd /path/to/re-news && docker compose -p re-news run --rm backup >/dev/null 2>&1`

## Acceptance criteria

**Deploy**
- [ ] `curl -sf http://localhost:3100/healthz` returns 200 without auth
- [ ] Unauthenticated `curl http://localhost:3100/` redirects to `/login` (plan 2 middleware still enforced)
- [ ] Push to `main` → GHA green → 2 images built and pushed < 10 min
- [ ] `docker images | grep ghcr.io/squadrone61/re-news` on server shows new `:latest` after Watchtower poll
- [ ] `docker inspect renews_web` `StartedAt` changes post-push; **`renews_db` unchanged**; other host containers unchanged
- [ ] Rollback to `:sha-<old>` via compose override + `pull && up -d` restores previous version
- [ ] `make migrate` applies a new migration without rebuilding images

**Polish**
- [ ] Two enabled jobs with `0 8 * * *` — editor shows collision warning with suggested offsets
- [ ] Next-5 preview displays 5 correct upcoming timestamps in server timezone
- [ ] Settings page shows `AccountInfo` (plan/tier) and timezone line
- [ ] Run detail shows `tokensIn / tokensOut / costUsd` on completed runs when SDK surfaced them
- [ ] Simulated rate-limit run shows a friendly formatted error with reset-time hint
- [ ] After 31 simulated days (backdate a run row), cleanup removes the working dir and keeps the DB row
- [ ] Nightly backup produces `./data/backups/<date>.sql.gz`; files older than 14 days purged

## Verification

```bash
# Health + auth gate
curl -o /dev/null -s -w '%{http_code}\n' http://localhost:3100/healthz  # 200
curl -s -o /dev/null -L -w '%{url_effective}\n' http://localhost:3100/ | grep -q '/login'

# CI
git commit --allow-empty -m "deploy smoke" && git push
# Wait for GH Actions green

# Watchtower roll
BEFORE=$(docker inspect renews_web --format '{{.State.StartedAt}}')
# wait poll interval
AFTER=$(docker inspect renews_web --format '{{.State.StartedAt}}')
[ "$BEFORE" != "$AFTER" ] && echo "ROLLED"
docker inspect renews_db --format '{{.State.StartedAt}}'  # unchanged

# Cron preview
curl -s -b /tmp/cj "http://localhost:3100/api/jobs/cron-preview?schedule=0+8+*+*+*" | jq

# AccountInfo
docker compose -p re-news exec worker cat /app/data/account_info.json | jq .plan

# Token capture
docker compose -p re-news exec db psql -U newsletter -d newsletter -c \
  "select tokens_in, tokens_out, cost_usd from runs where status='success' order by finished_at desc limit 3"

# Cleanup sim
docker compose -p re-news exec db psql -U newsletter -d newsletter -c \
  "update runs set finished_at = now() - interval '40 days' where id='<run>'"
# wait next 03:00 tick, or trigger:
docker compose -p re-news exec worker node -e "require('./dist/cleanup').run()"
docker compose -p re-news exec worker test ! -d /app/data/runs/<run> && echo GONE

# Backup
docker compose -p re-news run --rm backup
ls -la ./data/backups/
```

## Notes / gotchas

- **GHCR permissions**: first push may 403. Check `Settings → Actions → Workflow permissions = Read and Write`; `Settings → Packages` exists
- **Watchtower poll interval**: default 24h in many setups. Home-server value recommendation: `WATCHTOWER_POLL_INTERVAL=300` (5m). Don't go below 60s
- **Never label `db`**: auto-updating a data service is how you lose a night's data. `renews_db` explicitly has no Watchtower label
- **Session cookies over HTTP** are fine on LAN / Tailscale / Authelia. If ever port-forwarded, terminate TLS at a reverse proxy and flip the `secure` cookie flag (plan 2's `COOKIE_SECURE=1` env)
- **Don't edit Watchtower config blindly** — inspect first, list current watched set, plan the change so nothing watched goes dark
- **Prisma migrate on start is deliberately NOT automatic** in Dockerfile CMD — two containers starting simultaneously would race. Always run `make migrate` explicitly before rolling the app
- **Secrets on server**: `.env` owned by your user, `chmod 600`. Never committed. Compose reads it automatically
- **Token/cost accuracy**: SDK's ModelUsage shape varies by model/session. Treat as best-effort; not a billing source of truth
- **Backup restore is manual**: `gunzip -c backups/<date>.sql.gz | docker compose -p re-news exec -T db psql -U newsletter -d newsletter`. Document in README
- **Run-dir cleanup never deletes DB rows** — runs history is preserved; only the on-disk research/working dir is reclaimed
