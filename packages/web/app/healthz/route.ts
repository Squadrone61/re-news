export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    ok: true,
    version: process.env.APP_VERSION ?? 'dev',
  });
}
