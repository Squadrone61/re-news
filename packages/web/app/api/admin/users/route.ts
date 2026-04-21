import { HttpError, errorResponse, requireAdmin } from '@/src/lib/session';
import { UserCreateInput, prisma } from '@renews/shared';
import { hashPassword } from '@renews/shared/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireAdmin();
    const users = await prisma.user.findMany({
      select: { id: true, email: true, isAdmin: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return Response.json(users);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = await req.json().catch(() => null);
    const parsed = UserCreateInput.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'invalid input');
    const passwordHash = await hashPassword(parsed.data.password);
    try {
      const u = await prisma.user.create({
        data: {
          email: parsed.data.email,
          passwordHash,
          isAdmin: parsed.data.isAdmin,
        },
        select: { id: true, email: true, isAdmin: true, createdAt: true },
      });
      return Response.json(u, { status: 201 });
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
        throw new HttpError(409, 'email already exists');
      }
      throw err;
    }
  } catch (e) {
    return errorResponse(e);
  }
}
