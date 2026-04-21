# Plan 5 — Summary + Render + Email

**Goal**: Finish the pipeline. Stage 2 produces a strict JSON newsletter via a cheap tool-less SDK call, validated server-side with zod + one retry. The JSON is persisted to `runs.stage2Json`. It's then rendered into the job's `output_format` and sent via Gmail SMTP. Rendered output is persisted to `runs.renderedOutput`. Status flips `running → success` at the end. Admin-only Settings page exposes the shared sender credentials + default models.

**Depends on**: 4

## Scope

**In**
- `packages/worker/src/pipeline/summarize.ts` — SDK call, zod validation, 1 retry, persistence to `runs.stage2Json`
- `packages/worker/src/prompts/summary.ts` — spec §6 template + retry prompt
- `packages/worker/src/pipeline/render.ts` — markdown template, MD→HTML with inlined CSS (marked + juice), JSON passthrough
- `packages/worker/src/pipeline/email.ts` — Nodemailer + Gmail SMTP (`service: 'gmail'`, app password)
- Pipeline chain in `poll.ts`: `runResearch → runSummary → runRender → runEmail → setRunStatus('success')`
- `Setting` singleton table writes (admin-only): `gmail_user`, `gmail_app_password`, `sender_name`, `default_model_research`, `default_model_summary`, `worker_concurrency` (informational)
- `/settings` page (admin-only) with a form; `GET /api/settings` masks `gmail_app_password` as `"***"` when set, empty otherwise; `PUT /api/settings` takes partial updates; blank `gmail_app_password` means "no change"
- Post-parse defense-in-depth (belt & braces with plan 7): validator enforces max_items, body ≤50 words, subject ≤70 chars
- Empty research (`items: []`) → Stage 2 returns `empty_reason` — still send the email with that one line
- Persist rendered output to `runs.renderedOutput` (this is what the UI previews in plan 6)

**Out**
- Re-send action + re-run Stage 2 from UI (plan 6), rate-limit deferral (plan 7), token/cost capture (plan 8), custom templates (not in v1)

## Tasks

1. Install `zod`, `nodemailer`, `marked`, `juice` in worker (zod already in shared from plan 2; re-export)
2. `prompts/summary.ts`:
   - `buildSummaryPrompt(job, research)` — spec §6 template, no markdown fences (model mirrors what it sees)
   - `buildRetryPrompt()`: `"Your previous response violated a length rule or JSON shape. Re-emit strictly tighter JSON only — same schema, same max_items, no preamble."`
3. Zod schema + validator in `shared/src/schemas.ts`:
   ```ts
   export const StageTwoSchema = z.object({
     subject: z.string().max(70),
     intro: z.string().max(200),
     items: z.array(z.object({
       headline: z.string(),
       body: z.string(),
       source_url: z.string().url(),
     })),
     empty_reason: z.string().optional(),
   });
   export function validateLengths(p: StageTwo, maxItems: number) {
     if (p.items.length > maxItems) throw new Error(`too many items (${p.items.length} > ${maxItems})`);
     for (const it of p.items) {
       const words = it.body.trim().split(/\s+/).length;
       if (words > 50) throw new Error(`item body too long (${words} words)`);
     }
     if (p.subject.length > 70) throw new Error('subject too long');
   }
   ```
4. `pipeline/summarize.ts`:
   ```ts
   export async function runSummary(runId: string, job: Job, research: any) {
     const attempt = async (prompt: string) => {
       let output = '';
       for await (const msg of query({
         prompt,
         options: { allowedTools: [], permissionMode: 'default', model: job.modelSummary, maxTurns: 1 },
       })) {
         if (msg.type === 'assistant') output += extractText(msg);
         await streamLogToDb(runId, 'summary', msg);
       }
       const parsed = StageTwoSchema.parse(JSON.parse(output));
       validateLengths(parsed, job.maxItems);
       return parsed;
     };

     try {
       return await attempt(buildSummaryPrompt(job, research));
     } catch (e) {
       await streamLogToDb(runId, 'sys', `stage2 retry: ${String(e)}`);
       try {
         return await attempt(buildRetryPrompt());
       } catch (e2) {
         throw new Error(`stage2 validation failed after retry: ${String(e2)}`);
       }
     }
   }
   ```
5. `pipeline/render.ts`:
   - `renderMarkdown(parsed)` — template with `{{intro}}`, `---`, per-item `### headline\n\n{body}\n\n[Source]({source_url})`
   - If `parsed.items.length === 0` → markdown body is just the `empty_reason` (no padding)
   - `renderHtml(parsed)` — `juice(marked(renderMarkdown(parsed)))` with minimal inline-safe CSS (sans-serif, small max-width, line-height 1.5)
   - `renderJson(parsed)` — `JSON.stringify(parsed, null, 2)`
   - Returns a plain string
6. `pipeline/email.ts`:
   - Read the Settings row; throw if `gmail_user` / `gmail_app_password` / `sender_name` missing
   - `transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } })`
   - `sendMail({ from: "${name}" <${gmail_user}>, to: job.recipientEmail, subject: parsed.subject, text: format==='html'? stripHtml(rendered): rendered, html: format==='html'? rendered: undefined })`
   - On send error → throw so the poll loop sets `status='failed'` with `error="email send: <msg>"`
7. Wire in `poll.ts`: after `runResearch` resolves, `const s2 = await runSummary(...)`; persist `stage2Json: s2`; then `const rendered = await runRender(job, s2)`; persist `renderedOutput: rendered`; then `await runEmail(job, s2, rendered)`; then flip status to `success` with `finishedAt`
8. `/api/settings` (GET/PUT, admin-only):
   - GET: return current row; replace `gmailAppPassword` with `"***"` if non-empty, else empty string
   - PUT: zod-validate partial; ignore empty `gmailAppPassword` (means "no change"); upsert row
9. `/settings` UI (admin-only route): form with Gmail user, app password (password input, placeholder `"***"` when already set), sender name, default models, worker concurrency (informational in v1)
10. Update job create/edit form: `modelResearch` / `modelSummary` defaults fall back to Settings' defaults if set

## Acceptance criteria

- [x] Configure `/settings` with a real Gmail account + app password
- [x] Trigger a run on a job with `outputFormat:"html"`; recipient receives an email with the Stage 2 `subject`, rendered body, within ~30s of `status=success`
- [x] `runs.stage2Json` is the parsed Stage 2 object; `runs.renderedOutput` is the rendered string
- [x] Status ends `success` with `finishedAt` populated
- [x] Empty-items research → email delivered with the one-line `empty_reason`, no padding
- [x] SMTP failure → `status=failed`, `error="email send: <reason>"`
- [x] Forced validation failure (patch the prompt to break the length rule temporarily) → retry path fires; retry logs present; if retry also fails, `status=failed` with `error="stage2 validation failed after retry: ..."`
- [x] `GET /api/settings` masks `gmailAppPassword` as `"***"` when set; never leaks plaintext
- [x] Non-admin user cannot `GET` or `PUT` `/api/settings` (403)

## Verification

```bash
BASE=http://localhost:3100

# Admin configures settings
curl -s -b /tmp/cj -X PUT $BASE/api/settings -H 'content-type: application/json' -d '{
  "gmailUser":"newsletter-bot@gmail.com",
  "gmailAppPassword":"xxxx xxxx xxxx xxxx",
  "senderName":"re-news",
  "defaultModelResearch":"claude-sonnet-4-6",
  "defaultModelSummary":"claude-haiku-4-5"
}'
curl -s -b /tmp/cj $BASE/api/settings | jq .gmailAppPassword  # "***"

# Trigger run (reuse job from plan 4)
RUN=$(curl -s -b /tmp/cj -X POST $BASE/api/jobs/$ID/run | jq -r .runId)

# Poll to terminal
for i in {1..120}; do
  S=$(docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
    "select status from runs where id='$RUN'" | tr -d ' ')
  echo "t+$((i*5))s status=$S"
  [ "$S" = "success" ] && break
  [ "$S" = "failed" ] && { docker compose -p re-news exec db psql -U newsletter -d newsletter -c \
    "select error from runs where id='$RUN'"; exit 1; }
  sleep 5
done

# Inspect persistence
docker compose -p re-news exec db psql -U newsletter -d newsletter -tc \
  "select stage2_json->'subject', length(rendered_output) from runs where id='$RUN'"

# Non-admin 403
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/cj-alice $BASE/api/settings  # 403

# Inbox check: manual
```

## Notes

- Acceptance criteria verified via the worker Testcontainers integration tests (mocked SDK + mocked nodemailer). Real Gmail send verification is a manual step per user (requires their Gmail app password).
- The SDK may emit stage 2 JSON wrapped in code fences even with "no markdown fences" in the prompt; `summarize.ts`'s `extractJson` strips fences / extracts the outermost `{…}` before `JSON.parse`.
- `poll.ts` now updates `job.lastRunAt` at the end of a successful run (mirrors `onFire`'s pre-enqueue write so manual Run Now also bumps it).

## Notes / gotchas

- **Gmail app password**: Gmail → 2FA on → Account → Security → App passwords → generate for "Mail". Not the account password
- **Gmail SMTP via `service: 'gmail'`** uses `smtp.gmail.com:465` TLS automatically
- **Daily cap ~500**; Plan 7's `monthly_budget` is the secondary cap
- **HTML safety**: our own generated HTML only — still inline CSS with juice (Gmail strips `<style>` blocks)
- **Do not log the app password** anywhere. Settings GET masks; Settings PUT ignores empty values (no accidental wipe)
- **`stage2Json` vs `renderedOutput`**: separate columns so each has a clear meaning. No mystery about which stage wrote what — an improvement over the earlier draft where one column held both
- **Retry prompt is intentionally short** and refers to "previous response" without spelling out the violation — saves tokens and is what works empirically
