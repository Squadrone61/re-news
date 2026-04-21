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
| SSE for live logs | Polling `run_logs` every 1s on the backend | At family scale, LISTEN/NOTIFY is not worth the complexity |
| `runs` columns | `stage2_json jsonb` + `rendered_output text` (separate) | Avoids a single column meaning different things at different lifecycle stages |
| Run status enum | `queued \| running \| success \| failed \| deferred` (no intermediate `research_done` / `summary_done`) | Recovery keys on `research_raw IS NOT NULL`, not status |
| Playwright MCP | Deferred to v1.1 | v1 worker skips `needs_browser` sources with a warning log |
| Deploy | GH Actions → GHCR (`ghcr.io/squadrone61/re-news-{web,worker}:latest` + `:sha-<sha>`) → existing Watchtower (label-scoped) | Home server already runs Watchtower; only our 2 app services labeled; `db` never auto-updated |
| Release channel | `:latest` auto-deploys on push to `main` | User accepts risk; rollback via `:sha-<oldsha>` documented |
| Isolation | Compose project `re-news`, container names `renews_*`, dedicated `renews_net`, no `network_mode: host`, per-service `mem_limit`/`cpus`, web on port 3100 | Protects user's other containers on the same host |
| Backups | Nightly `pg_dump` to `./data/backups/` via a cron container (plan 8) | Cheap insurance for job config + run history |
| Dev/test env | Linux home server only (the other PC); Claude Code runs there to help | User preference — no local Docker Desktop |

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
