import type { Metadata } from 'next';
import './globals.css';
import { HYDRATION_GATE_SCRIPT } from './hydration-gate';

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
      <head>
        {/* Must run before Next's webpack runtime: see hydration-gate.ts (fixes random React #418). */}
        <script dangerouslySetInnerHTML={{ __html: HYDRATION_GATE_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
