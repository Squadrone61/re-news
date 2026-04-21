import { getSession } from '@/src/lib/session';

export const dynamic = 'force-dynamic';

export async function POST() {
  const session = await getSession();
  session.destroy();
  return new Response(null, { status: 204 });
}
