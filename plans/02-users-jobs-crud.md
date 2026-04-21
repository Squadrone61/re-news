# Plan 2 — Users + Jobs CRUD (with real auth)

**Goal**: Session-based login from day one. First-run `/setup` creates the first admin. Admin can create additional users at `/admin/users`. Each user sees only their own jobs. Full CRUD on jobs works. "Run Now" inserts a `runs` row with `status=queued`; the worker doesn't pick it up yet (plan 3).

**Depends on**: 1

## Scope

**In**
- `iron-session` cookie auth (`renews_sess`, 7-day rolling, `SameSite=Lax`, `httpOnly`)
- argon2 password hashing via `@node-rs/argon2`
- Pages: `/setup` (first-run, one-shot), `/login`, `/logout`, `/admin/users` (admin-only)
- API: `/api/auth/{setup,login,logout,me}`, `/api/admin/users` (full CRUD, admin-only)
- `packages/web/middleware.ts`: unauth'd → `/login`; no users → `/setup`; excludes `/login`, `/setup`, `/healthz`, `/api/auth/*`, `/_next/*`
- `getCurrentUser(req)` in `packages/shared/src/auth.ts` — **real** implementation from day 1 (reads session cookie, looks up user)
- Jobs API: `GET/POST /api/jobs`, `GET/PUT/DELETE /api/jobs/:id`, `POST /api/jobs/:id/run` — all scoped by `user_id`, ownership 404 on mismatch
- UI: `/` (jobs table, user-scoped), `/jobs/new`, `/jobs/[id]` (editor per spec §9 fields), topbar with logout + `Admin` link
- Zod schemas for `JobInput`, `JobUpdate`, `SourceInput` in `packages/shared`
- Server-side cron validation (`cron-parser`); client-side humanization (`cronstrue`)
- Vitest tests: auth flows, CRUD happy path, ownership scoping, validation errors

**Out**
- Worker picking up queued runs (plan 3), rate limits (plan 7), Settings page (plan 5)

## Tasks

1. Install: `iron-session`, `@node-rs/argon2`, `cron-parser`, `zod` in web/shared; `cronstrue` in web only
2. `shared/src/auth.ts`:
   - `hashPassword(plain)`, `verifyPassword(plain, hash)` via argon2id
   - `sessionOptions`: cookie name `renews_sess`, password from `process.env.SESSION_PASSWORD`, ttl 7 days, `SameSite=Lax`, `httpOnly`, `secure` only when `process.env.NODE_ENV === 'production'` **and** `process.env.COOKIE_SECURE === '1'` (LAN HTTP default)
   - `getCurrentUser(req)`: reads session; returns `{id, email, isAdmin}` or throws 401
   - `requireAdmin(user)`: throws 403 if not admin
3. `shared/src/schemas.ts`: zod schemas + inferred types for Job, Source, User, LoginInput, SetupInput, UserCreateInput
4. `packages/web/middleware.ts`:
   - If path in public allowlist → next
   - If no users in DB → 307 to `/setup` (unless already on `/setup` or `/api/auth/setup`)
   - Else if no session → 307 to `/login?redirect=<path>`
   - Else → next with user id attached via header (for API routes to read cheaply)
5. `/api/auth/setup` (POST): 410 if any user exists; else zod-parse, hash password, insert first admin, set session, return user
6. `/api/auth/login` (POST): verify creds with a ~250ms min-time constant delay (mitigates timing attacks cheaply); set session; return user
7. `/api/auth/logout` (POST): destroy session; 204
8. `/api/auth/me` (GET): returns current user or 401
9. `/api/admin/users`:
   - `GET`: list (id, email, isAdmin, createdAt)
   - `POST`: create `{email, password, isAdmin}` (admin supplies the password; write-only)
   - `PUT /:id`: edit email / isAdmin / password reset (admin-supplied new password)
   - `DELETE /:id`: cannot delete self, cannot delete the last admin
   - All require `requireAdmin`
10. `/api/jobs` + `/api/jobs/:id` + `/api/jobs/:id/run`:
    - Every handler starts with `const user = await getCurrentUser(req)`
    - `GET /api/jobs`: admin → all jobs; non-admin → `where: { userId: user.id }`
    - `POST /api/jobs`: zod parse; cron-validate with `cron-parser`; insert `{...input, userId: user.id}`; respond with full job
    - `GET /api/jobs/:id`, `PUT`, `DELETE`: `findUnique`; if `job.userId !== user.id && !user.isAdmin` → 404
    - `POST /api/jobs/:id/run`: same ownership; insert runs row `{jobId, status: 'queued', startedAt: null}`; return `{runId}`
11. UI:
    - `/setup`: email + password form; visible only when `users.count === 0`; after success, redirect `/`
    - `/login`: email + password form; after success, redirect to `?redirect` or `/`
    - `/`: jobs table (Name, schedule humanized via cronstrue, last run status+rel, next run, enabled toggle, `Run Now`, `Edit`)
    - `/jobs/new` + `/jobs/[id]`: single reusable form — name, sources repeater (`url`, `hint`, `needs_browser`), topic, base_prompt (textarea + char count), recipient_email (prefilled with `currentUser.email` on new), schedule (preset dropdown: Hourly / Every 6h / Daily 08:00 / Weekly Mon 08:00 / 1st of month 09:00 / Custom), output_format, max_items (default 6), model_research (default `claude-sonnet-4-6`), model_summary (default `claude-haiku-4-5`), monthly_budget (default 60). `Save` / `Save & Run Now` / `Delete`
    - `/admin/users`: admin-only; table + create form; disable/enable admin toggle; delete confirmation
    - Topbar: user email + `Logout` link; `Admin` link visible to admins
12. Tests (Vitest, Testcontainers-node Postgres):
    - Setup flow: POST /api/auth/setup on empty DB → 200; second call → 410
    - Login: success → cookie set; bad password → 401; rate-limit (5 wrong in 5 min) → 429 (v1 keep simple: in-memory counter)
    - Unauth request to `/api/jobs` → 401
    - User A cannot GET/PUT/DELETE/run User B's job → 404
    - Admin can list all jobs across users
    - Cannot delete last admin
    - Invalid cron on create → 400 `{error:"invalid cron", field:"schedule"}`

## Acceptance criteria

- [x] Fresh DB → visiting `/` redirects to `/setup`; completing setup creates the admin and logs them in
- [x] Admin creates alice@…; alice logs in; sees empty jobs list; admin's jobs are NOT visible
- [x] `recipient_email` on the new-job form pre-fills with the logged-in user's email
- [x] Create a job via UI with 2 sources + `0 8 * * *`; appears in list; schedule shows "At 08:00 AM"; row has `user_id = alice.id`
- [x] Edit + save same job; `updated_at` moves forward
- [x] Toggle enabled via table; DB row flips
- [x] Delete job; its runs cascade-delete
- [x] Invalid cron → 400 with the documented shape; UI surfaces it inline
- [x] `POST /api/jobs/:id/run` returns `{runId}`; row exists in `runs` with `status=queued` (remains queued since worker isn't wired yet)
- [x] Alice cannot hit `/admin/users` (403) or read admin's job at `/api/jobs/:adminJobId` (404)
- [x] Logout clears cookie; next request redirects to `/login`
- [x] `password_hash` is argon2; never returned by any API response
- [x] `pnpm test` green

## Verification

```bash
BASE=http://localhost:3100

# Setup + login as admin
curl -s -c /tmp/cj -X POST $BASE/api/auth/setup -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"admin-pass-long"}'
curl -s -b /tmp/cj $BASE/api/auth/me | jq .isAdmin  # true

# Second setup should be closed
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/api/auth/setup -H 'content-type: application/json' \
  -d '{"email":"x@x.x","password":"xxx"}'  # 410

# Create a second user
curl -s -b /tmp/cj -X POST $BASE/api/admin/users -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"alice-pass","isAdmin":false}'

# Alice logs in
curl -s -c /tmp/cj-alice -X POST $BASE/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"alice-pass"}'

# Alice creates a job
JOB=$(curl -s -b /tmp/cj-alice -X POST $BASE/api/jobs -H 'content-type: application/json' -d '{
  "name":"Test Daily","enabled":true,"schedule":"0 8 * * *",
  "sources":[{"url":"https://example.com"}],
  "topic":"test","basePrompt":"Be terse.",
  "recipientEmail":"alice@example.com","outputFormat":"markdown","maxItems":6,
  "modelResearch":"claude-sonnet-4-6","modelSummary":"claude-haiku-4-5","monthlyBudget":60
}')
ID=$(echo "$JOB" | jq -r .id)

# Admin sees all jobs, alice sees only hers
curl -s -b /tmp/cj       $BASE/api/jobs | jq 'length'  # >= 1
curl -s -b /tmp/cj-alice $BASE/api/jobs | jq 'length'  # exactly 1

# Alice cannot admin
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/cj-alice $BASE/api/admin/users  # 403

# Ownership: alice cannot read a job created by admin
ADMIN_JOB=$(curl -s -b /tmp/cj -X POST $BASE/api/jobs -H 'content-type: application/json' -d '{...}' | jq -r .id)
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/cj-alice $BASE/api/jobs/$ADMIN_JOB  # 404

# Run Now inserts queued run
RUN=$(curl -s -b /tmp/cj-alice -X POST $BASE/api/jobs/$ID/run | jq -r .runId)
docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
  "select status from runs where id='$RUN'"  # queued

# Invalid cron
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/cj-alice -X POST $BASE/api/jobs \
  -H 'content-type: application/json' \
  -d '{"name":"x","schedule":"not a cron","sources":[],"topic":"x","basePrompt":"x","recipientEmail":"a@b.c","outputFormat":"markdown"}'  # 400

pnpm test
```

## Notes / gotchas

- `SESSION_PASSWORD` must be set in `.env` (iron-session requires ≥32 chars). Doc it in `.env.example`.
- Middleware runs on edge runtime by default; iron-session works there but double-check bundling. If it gets painful, move enforcement to a Node-runtime layout wrapper.
- Minimum-time constant delay on login keeps this simple; for a real rate-limiter add plan 8 brute-force protection if paranoid — not needed for LAN.
- Do not leak the Prisma client into the client bundle. Only API routes import it.
- `Run Now` leaves rows in `queued` until plan 3 ships. That's fine — the UI shows `queued` in the table.
- Plan 1 already defined the `users` table and all columns; this plan only adds behavior.
