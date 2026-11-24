'use client';

// Errors below the root layout that no inner boundary caught: the (app) layout's
// session lookup, /login, /, /onboard, ... Rendered inside the root layout.
import { EngineReconnect } from '@/components/EngineReconnect';

export default function RootError({ error }: { error: Error & { digest?: string } }) {
  return <EngineReconnect error={error} fullScreen />;
}
