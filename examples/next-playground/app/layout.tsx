import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';
import './globals.css';
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: 'Fevex Playground',
  description: 'Playground Next.js para ejemplos de Fevex.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={cn("dark font-sans", geist.variable)}>
      <body>{children}</body>
    </html>
  );
}
