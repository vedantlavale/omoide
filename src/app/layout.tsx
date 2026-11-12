import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Omoide — a research agent that remembers',
  description:
    'A web-search agent with long-term, date-indexed memory and a claim ledger, so it can answer "is that still true?"',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
