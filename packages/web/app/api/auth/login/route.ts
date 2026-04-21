import { HttpError, errorResponse, getSession } from '@/src/lib/session';
import { LoginInput, prisma } from '@renews/shared';
import { verifyPassword } from '@renews/shared/auth';

export const dynamic = 'force-dynamic';

const attempts = new Map<string, { count: number; firstAt: number }>();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function rateLimit(key: string): boolean {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now });
    return true;
  }
  rec.count++;
  return rec.count <= MAX_ATTEMPTS;
}

export async function POST(req: Request) {
  const started = Date.now();
  try {
    const body = await req.json().catch(() => null);
    const parsed = LoginInput.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'invalid input');

    const key = parsed.data.email.toLowerCase();
    if (!rateLimit(key)) throw new HttpError(429, 'too many attempts');

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    const ok = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;

    const elapsed = Date.now() - started;
    if (elapsed < 250) await new Promise((r) => setTimeout(r, 250 - elapsed));

    if (!user || !ok) throw new HttpError(401, 'invalid credentials');

    const session = await getSession();
    session.userId = user.id;
    await session.save();
    return Response.json({ id: user.id, email: user.email, isAdmin: user.isAdmin });
  } catch (e) {
    return errorResponse(e);
  }
}
