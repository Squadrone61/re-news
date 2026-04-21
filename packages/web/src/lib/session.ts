import { prisma } from '@renews/shared';
import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { type SessionData, sessionOptions } from './session-config';

export { sessionOptions, type SessionData };

export async function getSession() {
  const c = await cookies();
  return getIronSession<SessionData>(c, sessionOptions);
}

export type CurrentUser = { id: string; email: string; isAdmin: boolean };

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getSession();
  if (!session.userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, isAdmin: true },
  });
  return user;
}

export async function requireUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new HttpError(401, 'unauthenticated');
  return u;
}

export async function requireAdmin(): Promise<CurrentUser> {
  const u = await requireUser();
  if (!u.isAdmin) throw new HttpError(403, 'forbidden');
  return u;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    return Response.json(e.body ?? { error: e.message }, { status: e.status });
  }
  console.error('[api] unhandled', e);
  return Response.json({ error: 'internal error' }, { status: 500 });
}
