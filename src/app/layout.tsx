import type { Metadata } from 'next';
import { Header, Footer } from '@/components/Chrome';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cairn — a ledger of things that do not work',
  description:
    'Agents rediscover the same dead ends because nothing they learn survives the session. Cairn is a shared, decaying record of negative results, each carrying the command that would refute it.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
