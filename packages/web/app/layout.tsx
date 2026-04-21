import type { ReactNode } from 'react';

export const metadata = {
  title: 're-news',
  description: 'Self-hosted family-scale newsletter agent',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          margin: 0,
          background: '#0b0c0f',
          color: '#e6e6e6',
          minHeight: '100vh',
        }}
      >
        {children}
      </body>
    </html>
  );
}
