import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Job } from '@prisma/client';
import {
  type StageTwo,
  StageTwoSchema,
  prisma,
  streamLogToDb,
  validateLengths,
} from '@renews/shared';
import { buildRetryPrompt, buildSummaryPrompt } from '../prompts/summary.js';
import { type UsageTotals, addUsage, emptyUsage, extractUsage } from './usage.js';

export async function runSummary(
  runId: string,
  job: Job,
  research: unknown,
  usage: UsageTotals = emptyUsage(),
): Promise<StageTwo> {
  const attempt = async (prompt: string): Promise<StageTwo> => {
    let output = '';
    for await (const msg of query({
      prompt,
      options: {
        allowedTools: [],
        permissionMode: 'default',
        model: job.modelSummary,
        maxTurns: 1,
      },
    })) {
      output += extractText(msg);
      addUsage(usage, extractUsage(msg));
      await streamLogToDb(runId, 'summary', msg);
    }
    const json = extractJson(output);
    const parsed = StageTwoSchema.parse(JSON.parse(json));
    validateLengths(parsed, job.maxItems);
    return parsed;
  };

  let parsed: StageTwo;
  try {
    parsed = await attempt(buildSummaryPrompt(job, research));
  } catch (e) {
    await streamLogToDb(runId, 'sys', `stage2 retry: ${errMsg(e)}`);
    try {
      parsed = await attempt(buildRetryPrompt());
    } catch (e2) {
      throw new Error(`stage2 validation failed after retry: ${errMsg(e2)}`);
    }
  }

  await prisma.run.update({
    where: { id: runId },
    data: { stage2Json: parsed as object },
  });

  return parsed;
}

function extractText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const m = msg as Record<string, unknown>;
  if (m.type !== 'assistant') return '';
  const inner = m.message as Record<string, unknown> | undefined;
  const content = inner?.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') out += b.text;
    }
  }
  return out;
}

function extractJson(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('{')) return t;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence?.[1]) return fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
