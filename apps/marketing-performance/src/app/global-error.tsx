'use client';

// Last-resort boundary: replaces the root layout, so it brings its own <html>,
// <body> and stylesheet. Replaces Next's raw "Application error: a server-side
// exception has occurred" page.
import './globals.css';
import { EngineReconnect } from '@/components/EngineReconnect';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en" className="dark">
      <head>
        <title>Performance Marketing</title>
        <meta name="robots" content="noindex" />
      </head>
      <body>
        <EngineReconnect error={error} fullScreen />
      </body>
    </html>
  );
}
