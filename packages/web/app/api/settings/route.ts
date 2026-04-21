import { HttpError, errorResponse, requireAdmin } from '@/src/lib/session';
import { SettingsInput, prisma } from '@renews/shared';

export const dynamic = 'force-dynamic';

const MASK = '***';

export async function GET() {
  try {
    await requireAdmin();
    const row = await prisma.setting.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
    return Response.json({
      gmailUser: row.gmailUser ?? '',
      gmailAppPassword: row.gmailAppPassword ? MASK : '',
      senderName: row.senderName ?? '',
      defaultModelResearch: row.defaultModelResearch,
      defaultModelSummary: row.defaultModelSummary,
      workerConcurrency: row.workerConcurrency,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: Request) {
  try {
    await requireAdmin();
    const body = await req.json().catch(() => null);
    const parsed = SettingsInput.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'invalid input');

    const data: Record<string, unknown> = {};
    const d = parsed.data;
    if (d.gmailUser !== undefined) data.gmailUser = d.gmailUser || null;
    if (d.senderName !== undefined) data.senderName = d.senderName || null;
    if (d.defaultModelResearch !== undefined) data.defaultModelResearch = d.defaultModelResearch;
    if (d.defaultModelSummary !== undefined) data.defaultModelSummary = d.defaultModelSummary;
    if (d.workerConcurrency !== undefined) data.workerConcurrency = d.workerConcurrency;
    // Empty password = "no change"; only write when non-empty.
    if (
      d.gmailAppPassword !== undefined &&
      d.gmailAppPassword !== '' &&
      d.gmailAppPassword !== MASK
    ) {
      data.gmailAppPassword = d.gmailAppPassword;
    }

    await prisma.setting.upsert({
      where: { id: 1 },
      create: { id: 1, ...data },
      update: data,
    });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
