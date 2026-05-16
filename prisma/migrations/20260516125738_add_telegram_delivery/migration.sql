-- AlterTable: jobs gains delivery-channel discriminator and telegram fields.
-- recipient_email goes nullable since telegram jobs don't need an email.
ALTER TABLE "jobs"
  ADD COLUMN "delivery_channel"     TEXT NOT NULL DEFAULT 'email',
  ADD COLUMN "telegram_chat_id"     TEXT,
  ADD COLUMN "telegram_chat_type"   TEXT,
  ADD COLUMN "telegram_chat_title"  TEXT,
  ALTER COLUMN "recipient_email" DROP NOT NULL;

-- AlterTable: settings gains shared bot creds + getUpdates cursor.
ALTER TABLE "settings"
  ADD COLUMN "telegram_bot_token"      TEXT,
  ADD COLUMN "telegram_bot_username"   TEXT,
  ADD COLUMN "telegram_update_offset"  BIGINT NOT NULL DEFAULT 0;

-- CreateTable: short-lived link tokens minted when the user clicks "Link Telegram".
-- Worker's getUpdates loop redeems them when the matching /start <token> or
-- /link <token> arrives from Telegram.
CREATE TABLE "job_link_tokens" (
    "token"      TEXT NOT NULL,
    "job_id"     UUID NOT NULL,
    "kind"       TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at"    TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_link_tokens_pkey" PRIMARY KEY ("token")
);

CREATE INDEX "job_link_tokens_job_id_idx" ON "job_link_tokens"("job_id");

ALTER TABLE "job_link_tokens"
  ADD CONSTRAINT "job_link_tokens_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
