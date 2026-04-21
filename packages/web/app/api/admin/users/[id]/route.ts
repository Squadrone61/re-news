import { HttpError, errorResponse, requireAdmin } from '@/src/lib/session';
import { UserUpdateInput, prisma } from '@renews/shared';
import { hashPassword } from '@renews/shared/auth';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const me = await requireAdmin();
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const parsed = UserUpdateInput.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'invalid input');

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw new HttpError(404, 'not found');

    if (parsed.data.isAdmin === false && target.isAdmin) {
      const adminCount = await prisma.user.count({ where: { isAdmin: true } });
      if (adminCount <= 1) throw new HttpError(400, 'cannot demote last admin');
      if (target.id === me.id) throw new HttpError(400, 'cannot demote self');
    }

    const data: Record<string, unknown> = {};
    if (parsed.data.email !== undefined) data.email = parsed.data.email;
    if (parsed.data.isAdmin !== undefined) data.isAdmin = parsed.data.isAdmin;
    if (parsed.data.password !== undefined) {
      data.passwordHash = await hashPassword(parsed.data.password);
    }
    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, email: true, isAdmin: true, createdAt: true },
    });
    return Response.json(updated);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const me = await requireAdmin();
    const { id } = await params;
    if (id === me.id) throw new HttpError(400, 'cannot delete self');
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw new HttpError(404, 'not found');
    if (target.isAdmin) {
      const adminCount = await prisma.user.count({ where: { isAdmin: true } });
      if (adminCount <= 1) throw new HttpError(400, 'cannot delete last admin');
    }
    await prisma.user.delete({ where: { id } });
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
