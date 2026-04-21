import { getCurrentUser } from '@/src/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const u = await getCurrentUser();
  if (!u) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  return Response.json(u);
}
