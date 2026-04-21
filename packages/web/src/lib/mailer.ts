import { prisma } from '@renews/shared';
import nodemailer from 'nodemailer';

export type SendArgs = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export async function sendConfiguredMail(args: SendArgs): Promise<string> {
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  if (!settings?.gmailUser || !settings.gmailAppPassword || !settings.senderName) {
    throw new Error('email settings incomplete (gmail_user/gmail_app_password/sender_name)');
  }
  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: settings.gmailUser, pass: settings.gmailAppPassword },
  });
  const info = await transport.sendMail({
    from: `"${settings.senderName}" <${settings.gmailUser}>`,
    to: args.to,
    subject: args.subject,
    text: args.text,
    html: args.html,
  });
  return info.messageId ?? 'n/a';
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
