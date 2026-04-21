import { logger, prisma, streamLogToDb } from '@renews/shared';
import nodemailer from 'nodemailer';

export async function sendFailureNotice(runId: string): Promise<void> {
  try {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: { job: { include: { user: true } } },
    });
    if (!run) return;

    const settings = await prisma.setting.findUnique({ where: { id: 1 } });
    if (!settings?.gmailUser || !settings.gmailAppPassword || !settings.senderName) {
      await streamLogToDb(
        runId,
        'sys',
        'failure-notice skipped: email settings incomplete',
        'warn',
      );
      return;
    }

    const base = process.env.BASE_URL ?? 'http://localhost:3100';
    const when = (run.finishedAt ?? new Date()).toISOString();
    const errText = run.error ?? 'unknown error';
    const jobName = run.job.name;
    const to = run.job.user.email;

    const transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: settings.gmailUser, pass: settings.gmailAppPassword },
    });

    const from = `"${settings.senderName}" <${settings.gmailUser}>`;
    const subject = `[re-news] Job failed: ${jobName}`;
    const body = `${jobName} failed at ${when}: ${errText}. See ${base}/runs/${runId}`;

    const info = await transport.sendMail({ from, to, subject, text: body });
    await streamLogToDb(
      runId,
      'sys',
      `failure-notice sent to ${to} (messageId=${info.messageId ?? 'n/a'})`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`failure-notice send failed for ${runId}: ${msg}`);
    try {
      await streamLogToDb(runId, 'sys', `failure-notice send failed: ${msg}`, 'warn');
    } catch {}
  }
}
