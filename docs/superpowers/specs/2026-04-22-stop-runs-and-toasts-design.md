# Stop in-flight runs + global action toasts — Design

Date: 2026-04-22

## Goal

Let users stop runs that are `queued` or `running` from the run list and run detail pages, with a confirmation dialog. In parallel, add a global toast system so user-initiated actions (stop, run now, enable/disable, save, etc.) give immediate success/failure feedback.

## Non-goals

- Cancelling `deferred` runs (the user can disable the job).
- Cancelling `failed` / `success` / `cancelled` runs (terminal).
- Per-stage cancel (e.g. "skip research, run stage 2 anyway") — out of scope.

## Data model

Migration: add one enum value and one boolean column.

```prisma
enum RunStatus {
  queued
  running
  success
  failed
  deferred
  cancelled   // NEW
}

model Run {
  // ...existing fields
  cancelRequested Boolean @default(false)  // NEW
}
```

Rationale for separating the flag from status: a run that has been requested-to-stop is still `queued` / `running` until the worker actually transitions it. Two columns keep "is it stopping?" and "is it stopped?" unambiguous in the UI.

The `cancelled` status is settled and terminal — no retry, no failure-notice email.

## API

### `POST /api/runs/:id/stop` (web, `runtime: 'nodejs'`)

- Verify ownership (same pattern as `/api/runs/:id/logs/stream`). Non-owner → 403.
- Load the run. Behavior by status:
  - `queued` — atomic
    `prisma.run.updateMany({ where: { id, status: 'queued' }, data: { status: 'cancelled', finishedAt: now, cancelRequested: false, error: 'cancelled by user' } })`.
    If `count === 0`, the worker just claimed it; fall through to the running path.
  - `running` — `prisma.run.update({ where: { id }, data: { cancelRequested: true } })`. The worker performs the actual transition.
  - `success | failed | deferred | cancelled` — 409 `{ error: "run is not stoppable" }`.
- Response: `{ status: <new-or-current-status> }`. Lets the client toast distinguish "Stopped" (queued path, immediate) from "Stopping…" (running path).
- Idempotent: re-clicking on a `running` row that already has `cancelRequested=true` is a no-op success.

No new endpoint touches the worker directly — coordination is entirely via Postgres.

## Worker cancellation

### `pipeline/research.ts`

- Create one `AbortController` per run; pass `abortController: controller` to the SDK `query({...})` call.
- Start a 1s "cancel-watch" `setInterval` that does
  `prisma.run.findUnique({ where: { id: runId }, select: { cancelRequested: true } })`.
  When `true`: `controller.abort()` and clear the interval.
- The `for await (const msg of query(...))` loop will throw on abort. Catch and re-throw as a new `CancelledError` (declared in `pipeline/errors.ts` next to `RateLimitError`).
- The cancel-watch interval must be cleared in a `finally` regardless of abort vs natural completion.

### `pipeline/errors.ts`

```ts
export class CancelledError extends Error {
  constructor() { super('cancelled by user'); this.name = 'CancelledError'; }
}
```

### `poll.execute`

Add cheap synchronous `cancelRequested` checks at stage boundaries (covers Stage 2's single short SDK call, render, and email — none of which the SDK abort can interrupt usefully):

- After research (or after the skip-research log line).
- After summary.
- After render persistence, before email.

Each check: re-read `cancelRequested` for `runId`; if `true`, throw `CancelledError`.

### `poll.handleFailure`

New first branch, **before** the rate-limit check:

```ts
if (err instanceof CancelledError) {
  await prisma.run.update({
    where: { id: runId },
    data: {
      status: 'cancelled',
      finishedAt: new Date(),
      heartbeatAt: null,
      cancelRequested: false,
      error: 'cancelled by user',
    },
  });
  await streamLogToDb(runId, 'sys', 'cancelled by user', 'warn').catch(() => {});
  return;
}
```

No retry path; no `sendFailureNotice`. `cancelled` is terminal.

### Stale recovery interaction

Unchanged. If the worker crashes between `cancelRequested=true` being set and acting on it, `staleRecovery` resets the row to `queued`. On next claim, the very first stage-boundary check inside `execute` (or the cancel-watch tick during research) throws `CancelledError`, settling the run to `cancelled`.

## Web UI

### Stop button

Run list page (`/runs`) and per-job runs table:

- Inline trailing action: small "Stop" button, rendered only when `status ∈ {queued, running}`.
- Click → confirm dialog → `POST /api/runs/:id/stop` → toast → `router.refresh()`.

Run detail page:

- Stop button in the page header next to existing actions, same visibility and flow.
- The existing SSE log stream emits `event: status` on transitions; the `cancelled` transition triggers the existing terminal-status branch (`router.refresh()`). Status badge re-renders server-side. No SSE changes needed.

### Confirm dialog

`packages/web/src/components/ConfirmDialog.tsx` — in-house, uses native `<dialog>`:

- Props: `open`, `title`, `body`, `confirmLabel`, `cancelLabel`, `onConfirm`, `onCancel`, `destructive?: boolean`.
- Backdrop dims; `Esc` closes (native `<dialog>` cancel event).
- Focus moves to the cancel button on open (safer default for destructive actions).
- No new dep.

For Stop: title `"Stop this run?"`, body `"Any partial work will be discarded."`, confirmLabel `"Stop"`, destructive styling.

### Status badge

Add `cancelled` to whatever badge map the run UI uses. Suggested neutral gray, distinct from red `failed`.

## Toast system

### Component

`packages/web/src/components/Toaster.tsx`:

- Context provider mounted once in the root layout: `<ToasterProvider>{children}<ToastViewport/></ToasterProvider>`.
- Hook: `useToast()` → `{ toast: { success, error, info } }`.
- Each `toast.X(message)` enqueues `{ id, kind, message, createdAt }`.
- Renders a fixed top-right stack; auto-dismiss after 4s; manual close button.
- Max 3 stacked — older ones drop.
- Pure CSS transitions, no animation lib, no new dep.
- Accessibility: success/info → `role="status" aria-live="polite"`. Error → `role="alert" aria-live="assertive"`.

### Wiring

Client-side fetches show toasts directly after the `fetch` resolves:

| Action | Success | Error |
|---|---|---|
| Stop run (queued path) | "Run stopped" | "Stop failed: <msg>" |
| Stop run (running path) | "Stopping…" | "Stop failed: <msg>" |
| Run Now | "Run queued" | "Could not enqueue: <msg>" |
| Resend email | "Email resent" | "Resend failed: <msg>" |
| Re-run Stage 2 | "Stage 2 rerun queued" | "Could not enqueue rerun: <msg>" |
| Enable / Disable job | "Job enabled" / "Job disabled" | "Could not change job: <msg>" |
| Save job (new + edit) | "Job saved" | "Save failed: <msg>" |
| Delete job | "Job deleted" | "Delete failed: <msg>" |
| Save Settings | "Settings saved" | "Save failed: <msg>" |

### Surviving redirects

For form pages that rely on a server-side redirect (job save → `/jobs`), the destination page reads a short-lived `?toast=<key>` URL param on mount, fires the corresponding toast, and replaces the URL to clear the param (`router.replace`). Avoids cookies / localStorage and survives the redirect.

A small registry of redirect-toast keys (e.g. `job_saved`, `job_deleted`, `settings_saved`) keeps the strings centralised.

## Testing

- API: `POST /api/runs/:id/stop` for each branch (queued, running, terminal, non-owner, race where queued becomes running between read and update).
- Worker: simulate `cancelRequested=true` mid-research and assert (a) the run settles to `cancelled`, (b) `sendFailureNotice` is NOT called, (c) no retry row, (d) cancel-watch interval is cleared.
- Worker: stage-boundary check fires correctly between research and summary.
- UI: smoke test the confirm dialog opens/closes; click-through fires the API; toast renders.
- Stale-recovery: crash while `cancelRequested=true`, restart, assert next claim transitions to `cancelled` via the first stage-boundary check.

## Migration plan

1. Prisma migration: enum value `cancelled` + `Run.cancelRequested Boolean @default(false)`. Run via `make migrate` before deploy (per CLAUDE.md: never auto-migrate on container boot).
2. Ship worker + web together — the web's stop endpoint is harmless before the worker handles it (the run will still terminate naturally) but the UX promise breaks, so deploy as one release.

## Open questions

None remaining at design time.
