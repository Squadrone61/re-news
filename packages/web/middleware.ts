import { getIronSession } from 'iron-session';
import { type NextRequest, NextResponse } from 'next/server';
import { type SessionData, sessionOptions } from './src/lib/session-config';

// Public paths: no auth required, no setup-gate redirect.
const PUBLIC = [
  '/login',
  '/setup',
  '/healthz',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/setup',
  '/api/auth/me',
  '/api/setup-status',
];

function isPublic(path: string) {
  if (PUBLIC.includes(path)) return true;
  if (path.startsWith('/_next/')) return true;
  if (path.startsWith('/favicon')) return true;
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  // Read session without DB access (edge-compatible).
  const res = NextResponse.next();
  const session = await getIronSession<SessionData>(req, res, sessionOptions);

  if (!session.userId) {
    if (pathname.startsWith('/api/')) {
      return Response.json({ error: 'unauthenticated' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
