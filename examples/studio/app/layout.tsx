import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
});

export const metadata: Metadata = {
  title: 'Fevex Studio',
  description: 'Consola local para runs, tools y approvals de Fevex.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html className={`${geistSans.variable} ${geistMono.variable}`} lang="es">
      <body>{children}</body>
    </html>
  );
}
