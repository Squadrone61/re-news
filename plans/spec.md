# re-news — Build Spec

Self-hosted, family-scale newsletter agent. Runs on one Linux home server, alongside the user's other containers. Produces scheduled, AI-generated newsletters from user-defined sources and topics using the Claude Agent SDK (subscription auth, no API key). Multi-user app (3–4 family members); single shared Claude subscription under the hood. Configured and monitored via a web UI.

> **This document is the product-level spec as frozen at v1.** All 8 implementation plans have shipped; their individual files have been removed. For current architecture + non-obvious constraints see `CLAUDE.md`; for the Decisions Log see `plans/README.md`. Use this file to understand *what* was built and *why* at the product level.

---

## 1. Goals & Non-Goals

**Goals**
- Multiple users (family members) each define their own newsletter jobs: sources, topic, base prompt, recipient email, schedule
- Scheduler fires jobs independently on arbitrary cron cadences (hourly, daily, weekly, 1st of month, custom)
- Two-agent pipeline per run: a research agent pulls content, a summarizer agent produces a concise newsletter
- Web UI for CRUD on jobs, viewing run history, tailing live logs, previewing / resending outputs
- Runs on the existing home-server Docker host alongside current containers, without disrupting them
- Uses the admin's Claude Pro/Max subscription — no API key anywhere; users never touch Claude credentials

**Non-Goals (for v1)**
- Public internet exposure without a reverse proxy — assume LAN-only, or behind Authelia / Tailscale
- Scale beyond ~4 users and ~10 runs/day — the architecture is intentionally sized for family use
- Deterministic scraping rules per source — the research agent figures out the best fetch method
- Self-signup — admin creates users via `/admin/users`
- Per-user Claude accounts — all runs use the single admin-mounted subscription

---

## 2. High-Level Architecture

Three services in a single Docker Compose stack:

| Service  | Purpose                                                                           |
|----------|-----------------------------------------------------------------------------------|
| `web`    | Next.js 14 (App Router) — UI + API + session auth                                 |
| `worker` | Long-running node process — embeds cron scheduler + polls DB for queued runs + runs the two-agent pipeline + sends email |
| `db`     | Postgres 16 (Prisma ORM, also acts as the job queue via polling)                  |

**No Redis, no BullMQ, no separate scheduler service.** At family scale, a DB-polling queue is simpler than a message broker. The worker embeds `node-cron` for schedule firing and polls the `runs` table every 5s for `queued` rows. Manual "Run Now" inserts a queued row directly and is picked up within 5s.

**Data flow**
```
[Web UI] --writes--> [DB: jobs, users, runs]
                              ^
                              | (cron fires + 5s poll)
                        [Worker] --runs--> Claude Agent SDK (Stage 1: research)
                                 --runs--> Claude Agent SDK (Stage 2: summarize)
                                 --renders--> markdown / html / json
                                 --sends--> Gmail SMTP (Nodemailer)
                                 --writes--> [DB: runs, run_logs]
                                                       ^
                                                       |
                                                  [Web UI] tails for live logs (SSE)
```

---

## 3. Tech Stack

- **Language**: TypeScript everywhere (single ecosystem, SDK is first-class in TS)
- **Monorepo**: pnpm workspaces (light, TS-native)
- **Lint / format**: Biome (single tool, no ESLint + Prettier split)
- **Tests**: Vitest (+ Testcontainers-node for DB integration tests)
- **Type check**: `tsc --noEmit`
- **Web framework**: Next.js 14+ (App Router) — UI + API routes in one container
- **ORM**: Prisma (easy migrations, good Postgres support)
- **DB**: Postgres 16 (JSONB for sources, research_raw, stage2_json)
- **Scheduler**: `node-cron` embedded in the worker process
- **Queue**: Postgres polling (no broker)
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk` (bundles the Claude Code binary)
- **Node base image**: `node:20-bookworm-slim` (glibc, for SDK binary compatibility)
- **Session auth**: `iron-session` cookie-based; argon2id password hashing via `@node-rs/argon2`
- **Email**: Gmail SMTP via `nodemailer` (dedicated Gmail + app password; shared sender across users)
- **Container**: Docker Compose, deployed alongside the user's existing home-server containers

---

## 4. Authentication

Two layers, kept separate:

**Layer 1 — App auth (multi-user, session cookies).**
- `iron-session` cookie (`renews_sess`, httpOnly, SameSite=Lax, 7-day rolling ttl).
- First-run `/setup` creates the initial admin (one-shot; locked after any user exists).
- Admin creates additional users at `/admin/users`. No self-signup.
- `getCurrentUser(req)` is real from plan 2 onward (no stub). All API handlers scope by `user_id`; admin can see all.
- argon2id password hashing. `SESSION_PASSWORD` (≥32 chars) in `.env`.

**Layer 2 — Claude Agent SDK auth (single shared subscription).**
- The SDK reads credentials from `~/.claude/` on the host. That directory is mounted **read-write** into the worker at `/root/.claude`. The SDK rotates refresh tokens back into it.
- `CLAUDE_CODE_USE_SUBSCRIPTION=1` on the worker. **Never** set `ANTHROPIC_API_KEY`.
- One-time host setup:
  1. `npm i -g @anthropic-ai/claude-code`
  2. Run `claude` interactively and log in with the admin's Pro/Max account
  3. Confirm credentials at `~/.claude/`
- If tokens ever expire: re-run `claude` on the host; the worker picks up new creds on its next run.

**Anthropic policy note.** Policy forbids *re-offering* claude.ai login to other users through your product. We don't — family users log into **re-news**, not into Claude. The shared `/root/.claude` is only ever the admin's subscription, used transparently for all users' pipeline runs.

---

## 5. Data Model

### `users`
| Column          | Type        | Notes                                   |
|-----------------|-------------|-----------------------------------------|
| `id`            | uuid PK     |                                         |
| `email`         | text UNIQUE |                                         |
| `password_hash` | text        | argon2id                                |
| `is_admin`      | bool        |                                         |
| `created_at`    | timestamptz |                                         |
| `updated_at`    | timestamptz |                                         |

### `jobs`
| Column                  | Type        | Notes                                                         |
|-------------------------|-------------|---------------------------------------------------------------|
| `id`                    | uuid PK     |                                                               |
| `user_id`               | uuid FK     | `onDelete: Cascade`                                           |
| `name`                  | text        | Display name                                                  |
| `enabled`               | bool        |                                                               |
| `schedule`              | text        | Cron expression, server-local time                            |
| `sources`               | jsonb       | `[{url, hint?, needs_browser?}]`                              |
| `topic`                 | text        |                                                               |
| `base_prompt`           | text        | User's long-form instructions for the summarizer              |
| `recipient_email`       | text        |                                                               |
| `output_format`         | text        | `markdown` \| `html` \| `json`                                |
| `max_items`             | int         | Default 6                                                     |
| `model_research`        | text        | Default `claude-sonnet-4-6`                                   |
| `model_summary`         | text        | Default `claude-haiku-4-5`                                    |
| `monthly_budget`        | int         | Soft cap on runs per month; exceeded → `deferred`             |
| `min_interval_minutes`  | int?        | Min gap between runs; below → fire skipped                    |
| `last_run_at`           | timestamptz |                                                               |
| `next_run_at`           | timestamptz | Denormalized for UI display + retry-backoff gating            |
| `created_at`            | timestamptz |                                                               |
| `updated_at`            | timestamptz |                                                               |

### `runs`
| Column              | Type        | Notes                                                   |
|---------------------|-------------|---------------------------------------------------------|
| `id`                | uuid PK     |                                                         |
| `job_id`            | uuid FK     | `onDelete: Cascade`                                     |
| `status`            | text        | `queued \| running \| success \| failed \| deferred`    |
| `attempt`           | int         | Retry counter; 0 on first attempt                       |
| `skip_research`     | bool        | Set by Re-run-Stage-2 action (plan 6)                   |
| `started_at`        | timestamptz |                                                         |
| `finished_at`       | timestamptz |                                                         |
| `heartbeat_at`      | timestamptz | Worker updates every 30s; drives stale-run recovery     |
| `next_run_at`       | timestamptz | Used by retry backoff to gate the poll                  |
| `research_raw`      | jsonb       | Stage 1 output; enables cheap Stage 2 re-runs           |
| `stage2_json`       | jsonb       | Stage 2 structured output                               |
| `rendered_output`   | text        | Final rendered newsletter (md/html/json as string)      |
| `tokens_in`         | int?        | From SDK `ModelUsage` where available (plan 8)          |
| `tokens_out`        | int?        |                                                         |
| `cost_usd`          | decimal?    |                                                         |
| `error`             | text?       |                                                         |

### `run_logs`
| Column    | Type         | Notes                                       |
|-----------|--------------|---------------------------------------------|
| `id`      | bigserial PK |                                             |
| `run_id`  | uuid FK      | `onDelete: Cascade`                         |
| `ts`      | timestamptz  |                                             |
| `level`   | text         | `debug` \| `info` \| `warn` \| `error`      |
| `stage`   | text         | `research` \| `summary` \| `email` \| `sys` |
| `message` | text         | Plain text extracted from SDK messages      |

### `settings` (singleton)
Admin-configured, shared across all users: `gmail_user`, `gmail_app_password`, `sender_name`, `default_model_research`, `default_model_summary`, `worker_concurrency` (informational).

---

## 6. The Two-Agent Pipeline

### Stage 1 — Research Agent

Receives the job's sources and topic. Decides per source whether to use `WebFetch` (static HTML), `Bash` + curl for RSS, or skip (JS-heavy sites flagged `needs_browser: true` — Playwright deferred to v1.1). Writes `research.json` to its working directory.

**SDK call (pseudocode)**
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const cwd = `/app/data/runs/${runId}`;
await fs.mkdir(cwd, { recursive: true });

for await (const msg of query({
  prompt: buildResearchPrompt(job),
  options: {
    allowedTools: ["WebFetch", "WebSearch", "Bash", "Read", "Write"],
    permissionMode: "acceptEdits",
    cwd,
    model: job.model_research,
    maxTurns: 40,
  },
})) {
  streamLogToDb(runId, "research", msg);
}

const research = JSON.parse(await fs.readFile(`${cwd}/research.json`, "utf8"));
```

**Research prompt (template, abridged — full form lives in `packages/worker/src/prompts/research.ts`)**
```
You are a research agent. Gather recent, relevant content from the sources
below related to the topic.

TOPIC: {{topic}}
LOOKBACK WINDOW: {{lookback}}   // derived from cron cadence
MAX ITEMS: 25
MAX CONTENT PER ITEM: 800 characters

SOURCES:
{{#each sources}}
- {{url}}  {{#if hint}}(hint: {{hint}}){{/if}}  {{#if needs_browser}}[skip: Playwright deferred]{{/if}}
{{/each}}

For each source, pick the best fetch method: WebFetch for static; Bash + curl
for RSS; skip with a fetch_errors entry if needs_browser.

Deduplicate by URL and near-identical titles. Skip items older than the
lookback window.

Write ./research.json with this exact schema:
{
  "fetched_at": "ISO",
  "items": [ { "source", "title", "url", "published_at", "content" } ],
  "fetch_errors": [ { "source", "reason" } ]
}

Do not invent items. Empty items[] is valid.
```

### Stage 2 — Summarizer Agent

Same SDK, no tools, single turn, cheaper model. Strict JSON output enforced by zod + server-side validator + one retry.

**SDK call (pseudocode)**
```ts
let output = "";
for await (const msg of query({
  prompt: buildSummaryPrompt(job, research),
  options: { allowedTools: [], permissionMode: "default", model: job.model_summary, maxTurns: 1 },
})) {
  if (msg.type === "assistant") output += extractText(msg);
  streamLogToDb(runId, "summary", msg);
}
const parsed = StageTwoSchema.parse(JSON.parse(output));
validateLengths(parsed, job.max_items);  // throws → retry once
```

**Summary prompt (template, abridged — full form in `packages/worker/src/prompts/summary.ts`)**
```
You are producing a newsletter. Input is raw research JSON.

HARD RULES:
- Max {{max_items}} items. Pick highest-signal; discard rest silently.
- Each item: headline ≤12 words, body exactly 1–2 sentences, ≤45 words.
- No preamble, no outro, no meta-commentary. No emoji.
- Merge overlapping items.
- If nothing interesting: empty items[] + one-line empty_reason. No padding.

Output: JSON only, no markdown fences, matching this schema:
{
  "subject": "string, ≤70 chars",
  "intro": "string, ≤25 words, or ''",
  "items": [ { "headline", "body", "source_url" } ],
  "empty_reason": "string (only if items empty)"
}

USER'S BRIEF:
{{base_prompt}}

RESEARCH JSON:
{{research_json}}
```

**Validator** (zod + length guard): items ≤ `max_items`, subject ≤ 70 chars, each item body ≤ 50 words, JSON parses. On violation → one retry with `"Your previous response violated a length rule. Re-emit strictly tighter."`. If retry also fails → run `failed` with `error="stage2 validation failed after retry"`.

### Rendering & Delivery

1. Parse structured output into `parsed`.
2. Render to the requested `output_format`:
   - `markdown` → simple `### headline` template
   - `html` → `marked(md) → juice(html)` for inlined CSS (Gmail strips `<style>`)
   - `json` → pretty-print
3. Send via Gmail SMTP (Nodemailer `service: 'gmail'`) using the admin-configured shared sender. `Subject` from Stage 2. Recipient is `job.recipient_email`.
4. Persist rendered string to `runs.rendered_output`; flip status to `success`.

---

## 7. Scheduling

- `worker` process embeds `node-cron`. On boot: `prisma.job.findMany({where:{enabled:true}})` → `cron.schedule(job.schedule, () => onFire(job.id))` for each.
- Reconcile tick every 60s re-reads the DB and updates the in-memory registry (add / remove / replace tasks whose schedule or enabled state changed). No Redis pubsub needed.
- On cron fire: re-read the job (bail if now disabled), run pre-checks (`min_interval_minutes`, `monthly_budget`), insert `runs` row with `status=queued`, update `jobs.next_run_at` via `cron-parser`.
- Separate 5s poll picks up `queued` rows (ordered by `created_at ASC`), atomically claims them via `updateMany({where:{id,status:'queued'}, data:{status:'running'}})`, and runs the pipeline in-process.

**Timezone**: server local time. Do **not** set `TZ` in Compose. Display in Settings UI:
```
Schedules use server time: ${Intl.DateTimeFormat().resolvedOptions().timeZone}
```

**Cron presets in UI**: Hourly, Every 6 hours, Daily 08:00, Weekly Monday 08:00, 1st of month 09:00, Custom (raw cron).

**Collision hints**: editor warns when a new schedule collides with another enabled job's fire minute. Suggests `:03`, `:17`, `:37` offsets (plan 8).

---

## 8. Rate Limit & Resilience Policy

Subscription auth means Pro/Max 5-hour rolling limits apply.

- **Global worker concurrency**: 1 (enforced structurally — one poll tick claims at most one row).
- **Per-job min interval**: `min_interval_minutes` gates both cron fires and manual Run Now.
- **Monthly budget check**: before inserting a new run row, count runs this month; if ≥ `monthly_budget`, insert with `status=deferred`, error="monthly budget exceeded", don't start the pipeline.
- **Rate-limit error handling**: SDK rate-limit errors → mark run `deferred`, `next_run_at = window_reset_time`, no retry. Never retry-loop on rate-limit.
- **Stale-run recovery**: heartbeat every 30s; on worker boot, `running` runs with heartbeat older than 5 min → reset to `queued` (Stage 1 recomputes; Stage 2 is a pure transform).
- **Generic retry policy**: 2 retries with exponential backoff (1m, 5m) implemented by stamping `next_run_at` on the row; poll filters on it. On 3rd failure → `failed` + one-line failure-notice email to the job's owner.
- **Research size caps**: enforced in the Stage 1 prompt (25 items / 800 chars each) **and** as a post-parse defense-in-depth truncation in the worker.

---

## 9. Web UI

Minimum screens for v1:

### Auth
- `/setup` — first-run only; creates the initial admin; locked after any user exists.
- `/login`, `/logout`.
- `/admin/users` (admin-only) — list, create, reset password, delete (can't delete self or last admin).
- Middleware redirects unauth'd requests to `/login` (or `/setup` if no users exist). Public allowlist: `/login`, `/setup`, `/healthz`, `/api/auth/*`, `/_next/*`.

### Jobs List (`/`)
Table columns: Name, Schedule (humanized via `cronstrue`), Last run (status + relative time), Next run, Enabled toggle, **Run Now** button, **Edit**. Scoped to the current user; admin sees all.

### Job Editor (`/jobs/new`, `/jobs/:id`)
- Name
- Sources: repeater with `url` (required), `hint` (optional), `needs_browser` checkbox
- Topic (one line)
- Base prompt (textarea + char count)
- Recipient email — pre-filled with `currentUser.email` on new jobs
- Schedule: preset dropdown + raw cron field + next-5-fires preview (plan 8)
- Output format: markdown / html / json
- Max items (default 6)
- Models: research (default sonnet-4-6), summary (default haiku-4-5)
- Monthly budget (default 60)
- Min interval minutes (optional)
- **Save** / **Save & Run Now** / **Delete**

### Runs List (`/runs`) and Run Detail (`/runs/:id`)
- Detail header: job name, status, timing, token/cost totals (when available)
- Live-tailed log panel (SSE backed by 1s poll), grouped by stage, collapsible per stage
- Collapsible **Raw research JSON** panel
- Rendered newsletter preview — sandboxed `<iframe sandbox="" srcdoc={rendered}>` for HTML; client-side `marked` render for markdown; `<pre>` for JSON
- Actions: **Resend email**, **Re-run Stage 2 only** (cheap — reuses `research_raw`), **Re-run full**
- Formatted errors on known prefixes (`rate_limit:`, `email send:`, `stage2 validation failed`)

### Settings (`/settings`, admin-only)
- Gmail user + app password (write-only, masked as `"***"` on read)
- Sender name
- Default models
- Worker concurrency (informational in v1)
- Footer: server timezone line
- `AccountInfo` badge: Claude plan/tier (plan 8)

---

## 10. Project Layout

```
re-news/
├── docker-compose.yml
├── docker-compose.migrate.yml   # one-shot migrate service
├── docker-compose.prod.yml      # GHCR image override for prod
├── Makefile                      # up / down / migrate / logs / psql / …
├── .env.example
├── README.md
├── CLAUDE.md
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── packages/
│   ├── web/              # Next.js: UI + API + middleware (auth)
│   │   ├── app/
│   │   ├── lib/
│   │   └── Dockerfile
│   ├── worker/           # node process: cron + poll + pipeline + email
│   │   ├── src/index.ts
│   │   ├── src/registry.ts
│   │   ├── src/poll.ts
│   │   ├── src/onFire.ts
│   │   ├── src/pipeline/
│   │   │   ├── research.ts
│   │   │   ├── summarize.ts
│   │   │   ├── render.ts
│   │   │   └── email.ts
│   │   ├── src/prompts/
│   │   │   ├── research.ts
│   │   │   └── summary.ts
│   │   └── Dockerfile
│   └── shared/           # Prisma client, auth helpers, zod schemas, logger, cron helpers
│       └── src/
├── data/                 # bind-mounts: postgres, runs, backups
└── plans/                # this directory (gitignored)
```

---

## 11. Docker Compose (outline)

```yaml
name: re-news

services:
  db:
    image: postgres:16-alpine
    container_name: renews_db
    environment:
      POSTGRES_DB: newsletter
      POSTGRES_USER: newsletter
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U newsletter -d newsletter"]
      interval: 5s
    networks: [renews_net]
    mem_limit: 512m
    cpus: 0.5

  web:
    build: { context: ., dockerfile: packages/web/Dockerfile }
    container_name: renews_web
    depends_on:
      db: { condition: service_healthy }
    environment:
      DATABASE_URL: postgres://newsletter:${DB_PASSWORD}@db:5432/newsletter
      SESSION_PASSWORD: ${SESSION_PASSWORD}
    ports: ["3100:3000"]
    labels: ["com.centurylinklabs.watchtower.enable=true"]
    networks: [renews_net]
    mem_limit: 512m
    cpus: 1.0

  worker:
    build: { context: ., dockerfile: packages/worker/Dockerfile }
    container_name: renews_worker
    depends_on:
      db: { condition: service_healthy }
    environment:
      DATABASE_URL: postgres://newsletter:${DB_PASSWORD}@db:5432/newsletter
      CLAUDE_CODE_USE_SUBSCRIPTION: "1"
    volumes:
      - ${HOME}/.claude:/root/.claude          # RW — SDK rotates tokens
      - ./data/runs:/app/data/runs
    labels: ["com.centurylinklabs.watchtower.enable=true"]
    networks: [renews_net]
    mem_limit: 2g
    cpus: 2.0

networks:
  renews_net:
    driver: bridge
```

**Migrations**: `docker-compose.migrate.yml` adds a one-shot `migrate` service running `pnpm prisma migrate deploy`. Invoke via `make migrate` before a release carrying a new migration.

**Production image override**: `docker-compose.prod.yml` replaces the `build:` blocks with `image: ghcr.io/squadrone61/re-news-<svc>:latest` for `web` and `worker`.

---

## 12. Build Order (shipped)

v1 was built in 8 sequenced plans, all completed:

1. **Skeleton** — monorepo, 3-service Compose, Prisma schema, healthchecks, `/healthz`, migrate override
2. **Users + Jobs CRUD** — iron-session auth, users table, full Jobs CRUD scoped per user, Run Now inserts queued run
3. **Worker Loop** — embedded cron + 5s poll, heartbeat, stale recovery
4. **Research Agent** — Stage 1 SDK call, `research.json`, streams logs
5. **Summary + Render + Email** — Stage 2 + zod validation + render + Gmail SMTP + Settings page
6. **Run Detail UI** — SSE log tail, sandboxed preview, resend, re-run-Stage-2, re-run-full
7. **Hardening** — rate-limit → `deferred`, retries w/ backoff, monthly budget, min interval, failure notices
8. **Deploy + Polish** — GHA → GHCR → Watchtower, cron collision hints, AccountInfo, token/cost capture, run-dir cleanup, nightly `pg_dump` backups

Individual plan files were removed after shipping. The Decisions Log in `plans/README.md` retains the non-obvious choices made during execution.

---

## 13. Gotchas Checklist

- [ ] `~/.claude` mounted **read-write** into worker; container runs as root to match `/root/.claude`
- [ ] No `ANTHROPIC_API_KEY` anywhere in env / Compose / Dockerfiles
- [ ] `CLAUDE_CODE_USE_SUBSCRIPTION=1` on worker
- [ ] Node base image is `node:20-bookworm-slim` (glibc), not alpine
- [ ] No `TZ` override in Compose (use server local time)
- [ ] Stage 1 prompt caps item count (25) and per-item content (800 chars); worker also truncates post-parse
- [ ] Stage 2 prompt enforces bite-sized output with hard rules; server-side zod + length validator catches violations
- [ ] Stage 2 output: one retry on violation, then `failed`
- [ ] Rate-limit errors → `deferred`, **never retry-loop**
- [ ] Worker heartbeat (30s) + stale-run recovery on boot (5 min threshold)
- [ ] `research_raw` persisted — enables cheap Re-run-Stage-2 from UI
- [ ] `needs_browser: true` sources skipped with a `fetch_errors` entry (Playwright is v1.1)
- [ ] Gmail creds in `settings` table, not env; masked on GET; empty-on-PUT means "no change"
- [ ] Session auth from plan 2; `SESSION_PASSWORD` (≥32 chars) in `.env`
- [ ] Monthly budget + min interval checked before inserting a new run row (cron path AND manual Run Now)
- [ ] Cron-minute staggering hints in UI
- [ ] Sandboxed preview iframe uses `sandbox=""` (no flags)
- [ ] `renews_db` has **no** Watchtower label — never auto-update data services
- [ ] Nightly `pg_dump` backup scheduled via host crontab

---

## 14. Locked Decisions (previously "open questions")

All open questions from the original draft were decided before build. Change here first if revisiting for v1.1; then sweep `CLAUDE.md` and `plans/README.md`'s Decisions Log.

- **DB**: Postgres 16 (not SQLite). JSONB, migrations, family-scale but room to grow.
- **Web framework**: Next.js 14 App Router. All-TS monorepo; types shared via `packages/shared`.
- **Queue**: Postgres polling (no Redis / BullMQ). Simpler for our scale.
- **Scheduler**: embedded in `worker` (no separate service).
- **Structured output for Stage 2**: zod schema + length validator + 1 retry. Committed.
- **Playwright MCP**: deferred to v1.1. Worker skips `needs_browser` sources with a warning; v1.1 adds the MCP.
- **Email provider**: Gmail SMTP via Nodemailer with an app password. Not Resend — we don't own a verified domain. Shared admin-owned sender; per-job `recipient_email`.
- **Auth model**: Multi-user app (session cookies, per-user ownership) over a single shared Claude subscription (admin's, mounted into worker). No self-signup.
- **Auth timing**: session auth shipped with the first CRUD plan — not retrofitted later.
- **Deploy**: `:latest` auto-deploys via existing Watchtower on push-to-`main`. Rollback via `:sha-<oldsha>` override.
- **Dev/test env**: Linux home server only; no local Docker Desktop.
