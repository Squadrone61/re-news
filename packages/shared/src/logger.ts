import { prisma } from './index.js';

export type LogStage = 'research' | 'summary' | 'email' | 'sys';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogEntry = { message: string; level: LogLevel };

const MAX_TOOL_ARGS_CHARS = 200;
const MAX_TOOL_RESULT_CHARS = 200;

/**
 * Persist a log row for a run. Accepts either a raw string (worker-originated)
 * or an SDK message object (from `@anthropic-ai/claude-agent-sdk`'s `query()`);
 * in the latter case the message is expanded into one or more rows describing
 * assistant text, tool invocations, and tool results.
 */
export async function streamLogToDb(
  runId: string,
  stage: LogStage,
  input: unknown,
  level: LogLevel = 'info',
): Promise<void> {
  const entries = toLogEntries(input, level);
  if (entries.length === 0) return;
  await prisma.runLog.createMany({
    data: entries.map((e) => ({ runId, stage, message: e.message, level: e.level })),
  });
}

function toLogEntries(input: unknown, defaultLevel: LogLevel): LogEntry[] {
  if (typeof input === 'string') {
    if (input.length === 0) return [];
    return [{ message: input, level: defaultLevel }];
  }
  if (!input || typeof input !== 'object') return [];

  const msg = input as Record<string, unknown>;
  const type = msg.type;
  const entries: LogEntry[] = [];

  if (type === 'assistant') {
    const content = extractContent(msg);
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
        entries.push({ message: b.text, level: 'info' });
      } else if (b.type === 'tool_use') {
        const name = typeof b.name === 'string' ? b.name : 'tool';
        const args = truncate(safeStringify(b.input ?? {}), MAX_TOOL_ARGS_CHARS);
        entries.push({ message: `tool: ${name}(${args})`, level: 'info' });
      }
    }
    const err = typeof msg.error === 'string' ? msg.error : null;
    if (err) entries.push({ message: `assistant error: ${err}`, level: 'error' });
  } else if (type === 'user') {
    const content = extractContent(msg);
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result') {
        const text = stringifyToolResultContent(b.content);
        const isError = b.is_error === true;
        entries.push({
          message: `result: ${truncate(text, MAX_TOOL_RESULT_CHARS)}`,
          level: isError ? 'error' : 'info',
        });
      }
    }
  } else if (type === 'result') {
    if (msg.is_error === true) {
      const errs = Array.isArray(msg.errors) ? msg.errors.join('; ') : '';
      const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'error';
      entries.push({
        message: `result ${subtype}${errs ? `: ${errs}` : ''}`,
        level: 'error',
      });
    }
  }
  // system / partial_assistant / status / etc. are intentionally skipped — too noisy.

  return entries;
}

function extractContent(msg: Record<string, unknown>): unknown[] {
  const inner = msg.message as Record<string, unknown> | undefined;
  const content = inner?.content;
  return Array.isArray(content) ? content : [];
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c && typeof c === 'object') {
          const o = c as Record<string, unknown>;
          if (typeof o.text === 'string') return o.text;
        }
        return safeStringify(c);
      })
      .join('');
  }
  return safeStringify(content);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}
