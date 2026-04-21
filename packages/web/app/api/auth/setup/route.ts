import { HttpError, errorResponse, getSession } from '@/src/lib/session';
import { SetupInput, prisma } from '@renews/shared';
import { hashPassword } from '@renews/shared/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const existing = await prisma.user.count();
    if (existing > 0) throw new HttpError(410, 'setup closed');
    const body = await req.json().catch(() => null);
    const parsed = SetupInput.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid input', { error: 'invalid input' });
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const user = await prisma.user.create({
      data: { email: parsed.data.email, passwordHash, isAdmin: true },
      select: { id: true, email: true, isAdmin: true },
    });
    const session = await getSession();
    session.userId = user.id;
    await session.save();
    return Response.json(user);
  } catch (e) {
    return errorResponse(e);
  }
}
