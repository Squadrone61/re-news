# re-news — Plans Index

Eight sequenced, independently-testable plans that deliver the product described in `spec.md`. Plans are numbered in dependency/build order; each states its dependencies explicitly. This directory is gitignored — local working notes, not a public artifact.

This plan set supersedes an earlier 11-plan draft. Scope was trimmed aggressively once the target shape became clear: **3–4 family users, ≤10 runs/day, one home server, one Claude subscription.**

## Plans

1. [Skeleton](./01-skeleton.md) — monorepo, 3-service Docker Compose, Prisma schema, healthchecks, `/healthz`, migrate override, stub services boot
2. [Users + Jobs CRUD](./02-users-jobs-crud.md) — session auth from day 1 (iron-session, /setup, /login), users table, full Jobs CRUD scoped per user, Run Now inserts a queued run
3. [Worker Loop](./03-worker-loop.md) — worker embeds node-cron (scheduling) + 5s poll (queue pickup); heartbeat + stale recovery; stub pipeline flips runs to success
4. [Research Agent](./04-research.md) — Stage 1 Claude Agent SDK with tools; writes `research.json`; persists to `runs.research_raw`; streams logs
5. [Summary + Render + Email](./05-summary-render-email.md) — Stage 2 structured JSON + zod validation + 1 retry; render to markdown/html/json; Gmail SMTP via Nodemailer; Settings page
6. [Run Detail UI](./06-run-detail.md) — `/runs/:id` page, SSE log tail (polling), sandboxed iframe preview, resend, re-run-Stage-2, re-run-full
7. [Hardening](./07-hardening.md) — rate-limit → `deferred`, retries w/ backoff, monthly budget, min interval, research caps, failure-notice emails
8. [Deploy + Polish](./08-deploy-polish.md) — GH Actions → GHCR → existing Watchtower (label-scoped); cron collision hints; next-5-fires preview; AccountInfo badge; token/cost capture; error formatting; run-dir cleanup; nightly pg_dump

**Shipped**: 1, 2, 3, 4, 5, 6. **Next**: 7.

## Decisions Log

Locked during planning. Change here first if you revisit; then sweep referencing plans.

| Topic | Decision | Rationale |
|---|---|---|
| Scale target | 3–4 users, ~10 runs/day, ~20 jobs lifetime max | User stated — shapes every other decision toward "less is more" |
| Services | 3: `web`, `worker`, `db` (no `scheduler`, no `queue`) | At this scale, a separate scheduler + Redis + BullMQ is machinery without payoff. Worker embeds node-cron and polls DB |
| Queue mechanism | Postgres polling (5s worker tick) | No Redis. Manual Run Now → queued row → worker picks up within 5s. Simple, no extra service |
| Hot-reload of schedules | Worker re-reads `jobs` every cron tick (no pubsub) | DB is the source of truth; next tick sees the latest schedule |
| Language | TypeScript across all packages | SDK is first-class TS; one ecosystem |
| Monorepo | pnpm workspaces | Light, TS-native, no Turborepo ceremony for 3 packages |
| Lint + format | Biome | Single tool replaces ESLint + Prettier; fast |
| Tests | Vitest | TS-native; workspace-aware |
| Type check | `tsc --noEmit` via root script | Standard |
| Web framework | Next.js 14+ App Router | UI + API in one container |
| ORM | Prisma | Easy migrations; good Postgres support |
| DB | Postgres 16 | JSONB for `sources` / `research_raw`; small ops cost |
| Node base image | `node:20-bookworm-slim` (glibc) | SDK bundles a native binary; alpine/musl risk avoided upfront |
| Agent SDK | `@anthropic-ai/claude-agent-sdk` with subscription auth | No API key; `~/.claude` mounted RW into worker |
| Research stage | Agentic (Sonnet + tools + `maxTurns: 40`) | User preference — keep the flexibility even if costlier |
| Email | Gmail SMTP via Nodemailer (dedicated Gmail + app password) | Resend requires verified domain; user has none. Gmail caps at 500/day/account — plenty |
| Auth model | **Multi-user app** (session login per user, per-user ownership) over a **single shared Claude subscription** (admin's, mounted RW into worker). Shared Gmail sender; per-user `recipient_email` per job. No self-signup; admin creates users via `/admin/users`. | Family use; Anthropic policy satisfied because users never touch Claude creds |
| Auth timing | Session auth shipped in plan 2 (not retrofitted in a later plan) | Avoids writing 6 plans worth of handlers against a stub and then refactoring |
| CSRF | `SameSite=Lax` session cookie + POST-only mutations; no token | Adequate for LAN + POST-everywhere |
| argon2 packaging | `@node-rs/argon2` exposed via `@renews/shared/auth` subpath only; webpack `externals` + `serverComponentsExternalPackages` on the web build | Native `.node` binary can't go through the edge middleware bundle or Next's file tracing under pnpm's symlinks. Root `@renews/shared` must stay edge-safe |
| Middleware auth response | 401 JSON for `/api/*`, 307 → `/login` for pages | API consumers choke on redirects; browser flows need the redirect |
| SSE for live logs | Polling `run_logs` every 1s on the backend | At family scale, LISTEN/NOTIFY is not worth the complexity |
| `runs` columns | `stage2_json jsonb` + `rendered_output text` (separate) | Avoids a single column meaning different things at different lifecycle stages |
| Run status enum | `queued \| running \| success \| failed \| deferred` (no intermediate `research_done` / `summary_done`) | Recovery keys on `research_raw IS NOT NULL`, not status |
| Playwright MCP | Deferred to v1.1 | v1 worker skips `needs_browser` sources with a warning log |
| Deploy | GH Actions → GHCR (`ghcr.io/squadrone61/re-news-{web,worker}:latest` + `:sha-<sha>`) → existing Watchtower (label-scoped) | Home server already runs Watchtower; only our 2 app services labeled; `db` never auto-updated |
| Release channel | `:latest` auto-deploys on push to `main` | User accepts risk; rollback via `:sha-<oldsha>` documented |
| Isolation | Compose project `re-news`, container names `renews_*`, dedicated `renews_net`, no `network_mode: host`, per-service `mem_limit`/`cpus`, web on port 3100 | Protects user's other containers on the same host |
| Backups | Nightly `pg_dump` to `./data/backups/` via a cron container (plan 8) | Cheap insurance for job config + run history |
| Dev/test env | Linux home server only (the other PC); Claude Code runs there to help | User preference — no local Docker Desktop |
| node-cron version | v4.x (async `stop()`/`destroy()`) | Latest; registry awaits both on unregister/shutdown |
| Worker test strategy | Testcontainers-backed Vitest integration tests at `packages/worker/src/__tests__/*.test.ts` — spins a throwaway `postgres:16-alpine`, runs `prisma migrate deploy`, exercises `onFire`/`poll.tick`/`staleRecovery` against real DB | Cron-tick acceptance is proven in shell verification (70s real time); unit-level tests cover the data-layer contracts without slow timers |
| Stale-run predicate | `status='running' AND (heartbeat_at IS NULL OR heartbeat_at < now()-5min)` → reset to `queued`, `started_at = NULL`, `heartbeat_at = NULL` | NULL heartbeat covers crash-before-first-heartbeat |
| Stage 2 JSON parsing | `summarize.ts` extracts JSON defensively: strips optional ``` / ```json fences and falls back to the outermost `{…}` substring before `JSON.parse`. | Models occasionally ignore "no markdown fences" in the prompt; rather than burn a retry, we pre-strip. If parse/zod/length still fails, the standard single-retry path runs. |
| Stage 2 retry trigger | Any throw in `attempt()` — JSON parse error, zod violation, or `validateLengths` throw — triggers the single retry with `buildRetryPrompt()`. Retry failure → `stage2 validation failed after retry: <reason>`. | One unified retry path is simpler than distinguishing parse vs. validation failures; the retry prompt is generic enough to cover both. |
| Rendered output persistence | `runs.renderedOutput` is written after `runSummary` but before `runEmail`, so a failed email still leaves the rendered artifact available (plan 6 resend reuses it). | Cheap to persist; decouples "rendered OK" from "email delivered". |
| Email format dispatch | `html` format → `sendMail({ html: rendered, text: stripHtml(rendered) })`. `markdown` / `json` → `text` only. Juice inlines CSS so Gmail doesn't strip our `<style>` block. | Gmail reliably keeps inlined styles; free-tier gmail blocks `<style>` and external refs. |
| Settings password semantics | `GET /api/settings` returns `"***"` for a set app password, `""` for unset. `PUT` treats `""`, `undefined`, and the literal `"***"` as "no change" — only a new non-empty non-mask string writes. | Prevents accidental wipes when a form submits after a GET without the user retyping the password. |
| Job-form defaults | Server component (`/jobs/new`) reads the singleton `Setting` row and passes `defaultModelResearch` / `defaultModelSummary` to `JobForm`; if Settings is absent, hardcoded fallbacks (`claude-sonnet-4-6` / `claude-haiku-4-5`) apply. Edit page reuses existing values (no change). | Plan 5 acceptance criterion #10. Keeps the form server-driven; no extra API round-trip. |
| Plan 4 transitional state | After Stage 1, runs stay `status='running'` (no flip to success, no `finishedAt`); heartbeat interval stops updating. Plan 5 wraps them up. Between plans, stale recovery may reset a running run to queued after 5 min and the poll loop re-runs Stage 1 — acceptable churn for a short transitional window. | Plan 4's scope explicitly stops at Stage 1; chaining Stage 2 is plan 5's responsibility |
| Research runs dir | Configurable via `RUNS_DIR` env var (default `/app/data/runs`). Worker integration tests set this to a `mkdtemp` dir so SDK mock writes don't collide with the production bind mount. | Testability; plan 4 originally hardcoded the path |
| SDK log mapping | `assistant.text` → `info` row; `tool_use` → `"tool: name(argsJSON)"` truncated at 200 chars; `tool_result` in `user` message → `"result: ..."` truncated at 200 chars (error level if `is_error`); `result.is_error` → `"result <subtype>: ..."` at error level. `system`/partial/status messages skipped. Full research JSON never logged — only the `sys` summary line. | Keeps `run_logs` useful for the live tail without dumping the full research payload (already in `runs.research_raw`) |
| Worker image extras | `git` and `curl` added to the worker Dockerfile in plan 4 for the SDK's Bash tool (curl for RSS, git for SDK housekeeping). | Bookworm-slim doesn't ship either by default |
| SDK import surface | `@anthropic-ai/claude-agent-sdk` is imported only from `packages/worker/src/pipeline/*`. `web` and `shared` must never import it. | Keeps the native Claude Code binary out of the Next.js bundle and the edge middleware |
| Resend transport (plan 6) | Web handler sends directly via a local `packages/web/src/lib/mailer.ts` (Nodemailer), re-reading the `Setting` singleton each call. No new run row; a single `sys` log line records the resend. | Worker is only reachable via the `runs` queue — adding a "resend" signal would mean a control-plane row. A direct send is one function call and stays on the request thread. |
| Run rerun split (plan 6) | Re-run Stage 2 inserts a new `runs` row with `skipResearch=true` + copied `researchRaw`; poll.execute branches on that flag to skip `runResearch()`. Re-run full uses the same path as Run Now. Old runs are never mutated. | History preserved; no schema-level polymorphism (`meta jsonb` was considered and rejected in favor of the dedicated `skip_research` bool already in the schema). |
| SSE implementation (plan 6) | Next.js route handler with `runtime='nodejs'` + `ReadableStream`, 1s polling on `run_logs` (gt lastSeenId) and `runs.status` separately. Headers: `text/event-stream`, `no-cache, no-transform`, `X-Accel-Buffering: no`. Closes on `req.signal` abort. | Edge runtime incompatible with iron-session/Prisma/long-lived streams. `X-Accel-Buffering: no` required if anything reverse-proxies in front. |
| HTML preview sandbox (plan 6) | `<iframe srcDoc={rendered} sandbox="">` — empty sandbox attribute, no `allow-same-origin`, no `allow-scripts`. | Opaque-origin iframe can still render inlined CSS; no script execution means no access to parent cookies/session. Adding `allow-same-origin` would defeat the purpose. |

## Plan Format

Every plan has the same shape:

- **Goal** — one-line definition of done
- **Depends on** — plan numbers
- **Scope (In / Out)** — bounds
- **Tasks** — ordered, concrete
- **Acceptance criteria** — checkboxes, each mechanically testable
- **Verification** — shell commands that prove the criteria

## How to use a plan

1. Read the plan. If you disagree with a decision, edit the Decisions Log here first.
2. Work the tasks in order. Check off acceptance criteria as you go.
3. Run the Verification block on the Linux home server. If any command fails, fix before declaring done.
4. Commit. Move to the next plan.
