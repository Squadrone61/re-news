import { prisma } from '@renews/shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const count = await prisma.user.count();
  return Response.json({ needsSetup: count === 0 });
}
