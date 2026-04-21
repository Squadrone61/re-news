-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'success', 'failed', 'deferred');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "schedule" TEXT NOT NULL,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "topic" TEXT NOT NULL,
    "base_prompt" TEXT NOT NULL,
    "recipient_email" TEXT NOT NULL,
    "output_format" TEXT NOT NULL DEFAULT 'markdown',
    "max_items" INTEGER NOT NULL DEFAULT 6,
    "model_research" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    "model_summary" TEXT NOT NULL DEFAULT 'claude-haiku-4-5',
    "monthly_budget" INTEGER NOT NULL DEFAULT 60,
    "min_interval_minutes" INTEGER,
    "last_run_at" TIMESTAMPTZ(6),
    "next_run_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "skip_research" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),
    "next_run_at" TIMESTAMPTZ(6),
    "research_raw" JSONB,
    "stage2_json" JSONB,
    "rendered_output" TEXT,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "cost_usd" DECIMAL(10,4),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_logs" (
    "id" BIGSERIAL NOT NULL,
    "run_id" UUID NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL DEFAULT 'info',
    "stage" TEXT NOT NULL,
    "message" TEXT NOT NULL,

    CONSTRAINT "run_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "gmail_user" TEXT,
    "gmail_app_password" TEXT,
    "sender_name" TEXT,
    "default_model_research" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    "default_model_summary" TEXT NOT NULL DEFAULT 'claude-haiku-4-5',
    "worker_concurrency" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "jobs_user_id_idx" ON "jobs"("user_id");

-- CreateIndex
CREATE INDEX "runs_job_id_idx" ON "runs"("job_id");

-- CreateIndex
CREATE INDEX "runs_status_idx" ON "runs"("status");

-- CreateIndex
CREATE INDEX "runs_heartbeat_at_idx" ON "runs"("heartbeat_at");

-- CreateIndex
CREATE INDEX "run_logs_run_id_idx" ON "run_logs"("run_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_logs" ADD CONSTRAINT "run_logs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
