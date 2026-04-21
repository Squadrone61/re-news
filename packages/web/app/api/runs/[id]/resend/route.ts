import { sendConfiguredMail, stripHtml } from '@/src/lib/mailer';
import { HttpError, errorResponse, requireUser } from '@/src/lib/session';
import { type StageTwo, prisma, streamLogToDb } from '@renews/shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  try {
    const me = await requireUser();
    const { id } = await params;
    const run = await prisma.run.findUnique({
      where: { id },
      include: { job: true },
    });
    if (!run) throw new HttpError(404, 'not found');
    if (!me.isAdmin && run.job.userId !== me.id) throw new HttpError(404, 'not found');
    if (!run.renderedOutput || !run.stage2Json) {
      throw new HttpError(409, 'run has no rendered output to resend');
    }

    const parsed = run.stage2Json as unknown as StageTwo;
    const isHtml = run.job.outputFormat === 'html';
    const messageId = await sendConfiguredMail({
      to: run.job.recipientEmail,
      subject: parsed.subject,
      text: isHtml ? stripHtml(run.renderedOutput) : run.renderedOutput,
      html: isHtml ? run.renderedOutput : undefined,
    });

    await streamLogToDb(
      run.id,
      'sys',
      `resent by user ${me.email} → ${run.job.recipientEmail} (messageId=${messageId})`,
    );
    return Response.json({ ok: true, messageId });
  } catch (e) {
    return errorResponse(e);
  }
}
