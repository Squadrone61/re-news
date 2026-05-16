/**
 * Thin Telegram Bot API wrapper. Shared by the delivery pipeline, the
 * getUpdates long-poll, and the failure-notice fallback. We don't need a
 * full SDK — every method we call is a single POST.
 *
 * Throws `TelegramApiError` on non-`ok` responses, with `parameters.retry_after`
 * captured when present so callers can convert 429s into `RateLimitError`.
 */

export class TelegramApiError extends Error {
  readonly statusCode: number | undefined;
  readonly errorCode: number | undefined;
  readonly description: string;
  readonly retryAfter: number | undefined;

  constructor(
    description: string,
    init: { statusCode?: number; errorCode?: number; retryAfter?: number },
  ) {
    super(description);
    this.name = 'TelegramApiError';
    this.statusCode = init.statusCode;
    this.errorCode = init.errorCode;
    this.description = description;
    this.retryAfter = init.retryAfter;
  }
}

export interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export async function tg<T = unknown>(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
  init?: { signal?: AbortSignal },
): Promise<T> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: init?.signal,
    });
  } catch (e) {
    throw new TelegramApiError(`network error: ${e instanceof Error ? e.message : String(e)}`, {});
  }
  const json = (await res.json().catch(() => null)) as TgResponse<T> | null;
  if (!json) {
    throw new TelegramApiError(`http ${res.status}: empty/invalid response`, {
      statusCode: res.status,
    });
  }
  if (!json.ok) {
    throw new TelegramApiError(json.description ?? `http ${res.status}`, {
      statusCode: res.status,
      errorCode: json.error_code,
      retryAfter: json.parameters?.retry_after,
    });
  }
  return json.result as T;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string; username?: string };
  text?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
  from?: { id: number; username?: string };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  my_chat_member?: {
    chat: { id: number; type: string; title?: string; username?: string };
    new_chat_member: { status: string };
  };
}
