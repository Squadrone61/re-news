import type { SessionOptions } from 'iron-session';

export type SessionData = {
  userId?: string;
};

const password = process.env.SESSION_PASSWORD ?? '';

export const sessionOptions: SessionOptions = {
  cookieName: 'renews_sess',
  password: password || 'dev-placeholder-please-replace-32chars!!',
  ttl: 60 * 60 * 24 * 7,
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === '1',
    path: '/',
  },
};
