import type { Job } from '@prisma/client';
import { type StageTwo, prisma, streamLogToDb } from '@renews/shared';
import nodemailer from 'nodemailer';

export async function runEmail(
  runId: string,
  job: Job,
  parsed: StageTwo,
  rendered: string,
): Promise<void> {
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  if (!settings?.gmailUser || !settings.gmailAppPassword || !settings.senderName) {
    throw new Error('email settings incomplete (gmail_user/gmail_app_password/sender_name)');
  }

  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: settings.gmailUser, pass: settings.gmailAppPassword },
  });

  const from = `"${settings.senderName}" <${settings.gmailUser}>`;
  const isHtml = job.outputFormat === 'html';

  try {
    const info = await transport.sendMail({
      from,
      to: job.recipientEmail,
      subject: parsed.subject,
      text: isHtml ? stripHtml(rendered) : rendered,
      html: isHtml ? rendered : undefined,
    });
    await streamLogToDb(
      runId,
      'email',
      `sent to ${job.recipientEmail} (messageId=${info.messageId ?? 'n/a'})`,
    );
  } catch (e) {
    throw new Error(`email send: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
