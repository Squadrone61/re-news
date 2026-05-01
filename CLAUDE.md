# CLAUDE.md

Guidance for Claude Code working in this repo. The code is the source of truth — this file lists the traps that bite if ignored. See `README.md` for what exists and how to deploy.

## What we're building

Self-hosted, family-scale (3–4 users, ≤10 runs/day) newsletter agent. Each user defines "jobs" (sources + topic + prompt + cron + recipient). On fire, a two-stage Claude pipeline (research with tools → strict-JSON summary) renders markdown/HTML/JSON and emails via Gmail SMTP. Web UI manages jobs, runs, and live logs.

Multi-user app, **single shared Claude Pro/Max subscription**: users log into our app, never into Claude. The worker mounts the admin's `~/.claude` and runs all users' jobs against it.

## Architecture

Three Docker services, no external broker:

- `web` — Next.js 14 App Router (UI + API + iron-session auth) on port 3100
- `worker` — embeds node-cron + 5s DB poll, runs the pipeline in-process; **only service that loads the Claude Agent SDK**
- `db` — Postgres 16 (Prisma); also acts as the queue

Monorepo: `packages/{web,worker,shared}` with Prisma schema at root. Per-run scratch in `data/runs/<runId>/` (bind-mounted RW into worker, RO into web).

## Non-obvious constraints

**Claude auth uses the subscription, not an API key.** SDK reads `~/.claude/`, mounted RW into the worker (it rotates refresh tokens back). `:ro` causes silent token-refresh failures. Never set `ANTHROPIC_API_KEY`. Worker runs as root so the mount target matches `/root/.claude`. `CLAUDE_CODE_USE_SUBSCRIPTION=1` is required.

**glibc, not musl.** SDK ships a native binary. `node:20-bookworm-slim` is committed; `node:20-alpine` has caused silent exec failures.

**SDK is worker-only.** `@anthropic-ai/claude-agent-sdk` is imported only from `packages/worker`. Never from `web` or `shared` — the bundler will choke on the native binary.

**Run status is a flat enum**: `queued | running | success | failed | deferred | cancelled`. No intermediate stage statuses. Stage 2 reads `research_raw` from the DB; recovery keys on heartbeat age, not status. `runs` has separate columns for `research_raw`, `stage2_json`, `rendered_output` — one column per lifecycle meaning.

**Rate limits are 5h rolling windows.** Worker concurrency is 1 (single-poll-at-a-time). Rate-limit error → `status='deferred'`, `nextRunAt=resetAt`, **no attempt bump**. Generic failure → retry up to 2× via `nextRunAt`-gated backoff (1m, 5m), then `failed` + failure-notice email. `tick()`'s `WHERE` filters on `nextRunAt` — that's how backoff works; don't bypass it.

**Two-stage pipeline split is load-bearing.** Stage 1 is a Haiku conductor (`maxTurns: 6`, tools: Task/WebSearch/Read/Write) that dispatches one `research-source` subagent (Sonnet, full fetch tools) per source via the SDK's `Task` tool. Each subagent writes `sources/<idx>.json` matching `SourceBriefSchema`; the conductor merges them into `research.json` (≤25 items, prompt-enforced; warn-only on summary >800 chars — no silent truncation; safety-belt at 50 items). Stage 2 (Haiku, no tools, `maxTurns: 1`) emits strict JSON validated by `StageTwoSchema` + `validateLengths` (subject ≤70, items ≤ `maxItems`; body length is style, not a correctness gate — driven by the user's brief). One retry on failure with a tighter prompt, then fail.

**Stage 1 outcomes are typed; Stage 2 trigger is gated on them.** `runResearch` returns a `Stage1Outcome` (`complete | partial | no_signal | aborted`) instead of throwing on missing files. `poll.execute` switches: `complete`/`partial` flow into Stage 2 (partial logs a `warn` and continues with whatever sources salvaged from `sources/*.json`); `no_signal`/`aborted` throw `Stage1IncompleteError` which the existing retry/fail path handles with a clear error code. The legacy `"research.json missing"` failure message is gone — if the conductor SDK process crashes mid-flight, `salvageFromSources` rebuilds a partial `research.json` from any usable per-source briefs on disk before deciding the outcome.

**Run cancellation.** `cancelled` is terminal — no retry, no failure-notice. `Run.cancelRequested` is a flag, not a status. Web sets the flag (or atomically transitions a `queued` row); worker flips a `running` row via a 1s `setInterval` that polls the flag and aborts the SDK's `AbortController`. Stage-boundary `throwIfCancelled()` checks cover summary/render/email (the SDK abort can't reach those). The `CancelledError` branch in `handleFailure` runs **before** rate-limit detection. Rerun endpoints don't carry the flag over.

**Preflight is shared.** `@renews/shared/preflight#preflightJob` is called from both `onFire` and `POST /api/jobs/:id/run` — keep them identical. Skip = no row. Defer = row with `status='deferred'`, `error=reason`, `finishedAt=now`. Monthly budget uses server-local month. Rerun endpoints (`/rerun-full`, `/rerun-stage2`) intentionally bypass preflight.

**Stale-run recovery on worker boot.** Any `running` run with `heartbeat_at` older than 5 min (or NULL) → reset to `queued`, `started_at=null`. Pipeline is idempotent; Stage 2 is a pure transform over `research_raw`. Worker updates `heartbeat_at` every 30s during execution.

**Re-run Stage 2 creates a new row** with `skip_research=true` and `research_raw` copied from the source. Never mutates history. The skip happens in `poll.execute`.

**Resend sends from web, not worker.** `POST /api/runs/:id/resend` calls `packages/web/src/lib/mailer.ts` (Nodemailer) directly. No new row, no enqueue — just one `sys` log line under the original run. Rotated Gmail creds take effect on the next call (no transport caching).

**Email = Gmail SMTP.** Resend (and other reputable providers) refuse free-email sender domains, and we don't own one. `pipeline/email.ts` throws `email settings incomplete` if `gmailUser`/`gmailAppPassword`/`senderName` are missing. SMTP failures rethrow as `email send: <reason>` and become `status='failed'`.

**Settings PUT preserves the password.** Empty string, literal `"***"`, or `undefined` for `gmailAppPassword` means **no change** — only a new non-empty non-mask string writes it. Prevents accidental wipe on GET → form-submit.

**Time/scheduling.** Set `TZ=Europe/Istanbul` on `web` and `worker`, and keep the `/etc/localtime` + `/etc/timezone` file bind-mounts. The bind-mounts alone aren't enough: when the host's `/etc/localtime` is a symlink (e.g. `→ /usr/share/zoneinfo/Europe/Istanbul`) and the container's `/etc/localtime` is also a symlink (e.g. `→ /usr/share/zoneinfo/Etc/UTC`), Docker follows both during the bind, so the host's tzdata ends up on disk at the path literally named `Etc/UTC`. `date`(1) reads contents and shows `+03`, but Node/ICU resolves `/etc/localtime`'s symlink *target path* as the zone name and sees `Etc/UTC` — so `new Date()`, `Intl`, node-cron and cron-parser all run in UTC and `0 8 * * *` fires at 08:00 UTC. The `TZ` env var bypasses this by telling ICU the zone directly. `db` doesn't need either.

**SSE log stream is `runtime: 'nodejs'`** (iron-session + Prisma + long streams aren't edge-safe). Polls `run_logs` every 1s with `id > lastSeenId`; emits `event: status` on `runs.status` transitions. `RunLog.id` is `BigInt` — track as `bigint`, serialize via `.toString()`, never compare to `Number`.

**HTML preview iframe uses `sandbox=""`** (empty — no `allow-same-origin`, no `allow-scripts`). Inlined CSS via `juice` still renders. Never add `allow-same-origin`; it would let newsletter HTML read the parent's cookies.

**argon2 (`@node-rs/argon2`) is native.** Exposed via `@renews/shared/auth` subpath only — never from the root entry. Edge middleware imports session cookie *config* from `lib/session-config.ts` only; Node session helpers (`getCurrentUser`, `requireAdmin`) live in `lib/session.ts`. Middleware can't hit the DB, so `/login` and `/setup` are public; `/login` does a client fetch to `/api/setup-status` to redirect to `/setup` when the DB is empty. Middleware returns 401 JSON for `/api/*`, 307 → `/login?redirect=<path>` for pages.

**Toasts are for action outcome.** `useToast()` from `app/_components/Toaster.tsx` (in-house, no dep). Form-redirect flows pass `?toast=<key>` to the destination; keys live in `REDIRECT_TOASTS` — add new keys to the registry, never hardcode at the call site. Inline field errors stay inline.

**Migrations run on container start.** Both `web` and `worker` have an entrypoint wrapper (`packages/{web,worker}/entrypoint.sh`) that runs `pnpm prisma migrate deploy` before the main command. Prisma's advisory lock on `_prisma_migrations_lock` serialises concurrent callers, so simultaneous Watchtower restarts of web+worker are safe. This is what makes the Watchtower → GHCR auto-update flow work without a manual `make migrate` step. `make migrate` still exists for the one-shot case (migrate against a stopped stack), but the normal path is: push → CI builds → Watchtower pulls → entrypoint migrates → app starts.

**Watchtower is shared with the host's other stacks.** Label-scoped (`WATCHTOWER_LABEL_ENABLE=true`). Only `renews_web` + `renews_worker` carry the enable label; `renews_db` is intentionally unlabeled — never auto-update a data service.

**`web` is fronted by a Caddy reverse proxy**, not by a published host port. `web` joins both `renews_net` (for DB) and the externally-managed `proxy_net` (for Caddy). Caddy lives in its own stack at `/home/safa/caddy-proxy/`, binds only to the host's Tailscale IP (tailnet-only), terminates TLS with certs from Let's Encrypt via Cloudflare DNS-01, and routes by hostname (`renews.safaakyuz.com`). `COOKIE_SECURE=1` is set on `web` because TLS terminates at Caddy; iron-session needs it to issue `Secure` cookies. The `proxy_net` is declared `external: true` — the Caddy stack owns it, and `docker network create proxy_net` must have been run on the host before `make up`/`make deploy`.

**`./data` is RO into web, RW into worker.** Web has the HTTP surface; a path-traversal bug there must not touch per-run artifacts. If a web feature genuinely needs to write, add a narrow API the worker owns.

**Playwright MCP is spawned per run, only when needed.** If any source on the job has `needs_browser: true`, `pipeline/research.ts` adds an `mcpServers.playwright` stdio subprocess (`@playwright/mcp` + bundled Chromium, `--isolated`, per-run `--output-dir`) and extends each `research-source` subagent's tool list with the `mcp__playwright__browser_*` subset (navigate, snapshot, wait_for, console_messages, click, press_key, handle_dialog, hover); the conductor itself never holds browser tools. Jobs with no browser sources spawn no Chromium. Browser failures surface as `fetch_errors` entries (`browser_failed` / `browser_timeout`), not run failures. Chromium is baked into the worker image via `playwright install --with-deps chromium`; `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` keeps it out of `$HOME`. Worker `mem_limit` is 3g to absorb a headless tab.

## Data model (one-line each)

- `users` — id, email (unique), password_hash (argon2id), is_admin
- `jobs` — per-user (cascade), config + `min_interval_minutes`, `monthly_budget`, `last_run_at`, `next_run_at`
- `runs` — `status`, `attempt`, `skip_research`, `cancel_requested`, `heartbeat_at`, `next_run_at`; artifacts in `research_raw` / `stage2_json` / `rendered_output`; usage in `tokens_in` / `tokens_out` / `cost_usd`
- `run_logs` — BigInt id, stage ∈ `research|summary|email|sys`
- `settings` — singleton: gmail_user, gmail_app_password, sender_name, default models, worker_concurrency

Full schema in `prisma/schema.prisma`.

## Commands

- `make up` / `make down` — start / stop the stack
- `make migrate` — `prisma migrate deploy` via the one-shot service
- `make logs` / `make psql` / `make shell-web` / `make shell-worker` / `make backup`
- `pnpm lint` / `pnpm typecheck` / `pnpm test` — quality gates (all three must pass)
- After editing `@renews/shared`: `pnpm --filter @renews/shared build` before web build/typecheck

## Conventions

- TypeScript everywhere, strict, `NodeNext`, `ES2022`. Dev/test runs on the Linux home server.
- The `shared` package owns the Prisma client singleton, session helpers, `streamLogToDb`, zod schemas, cron + preflight helpers, cross-service types. Don't duplicate types in `web` or `worker`.
- SDK streaming: iterate `for await (const msg of query({...}))` and pipe each message through `streamLogToDb` so the UI's live tail works.
- `.env` must define `SESSION_PASSWORD` (≥32 chars) and `DB_PASSWORD`. Gmail creds live in the Settings UI, not env.
