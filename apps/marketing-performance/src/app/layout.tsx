import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Performance Marketing',
  description:
    'A full-stack performance-marketing app on the SynapCores AI-native database: true ROAS vs. 90-day LTV, last-touch attribution, creative-angle embeddings, and an agentic budget recommendation — computed in one engine.',
  robots: { index: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
