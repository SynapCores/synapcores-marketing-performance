'use client';

// Errors from the signed-in pages; the sidebar and top bar stay around it.
// (Errors from (app)/layout.tsx itself, e.g. the session lookup, reach app/error.tsx.)
import { EngineReconnect } from '@/components/EngineReconnect';

export default function AppSegmentError({ error }: { error: Error & { digest?: string } }) {
  return <EngineReconnect error={error} />;
}
