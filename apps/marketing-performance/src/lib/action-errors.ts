// Client-safe: message for a rejected server action, shown in a panel.
import { isEngineUnavailableDigest } from '@synapcores/app-framework';

/**
 * Production builds replace a server action's error message with a generic
 * one but keep its digest; an "engine unreachable" digest gets `engineDown`.
 */
export function actionErrorMessage(e: unknown, engineDown: string): string {
  const digest = e && typeof e === 'object' ? (e as { digest?: unknown }).digest : undefined;
  if (typeof digest === 'string' && isEngineUnavailableDigest(digest)) return engineDown;
  return e instanceof Error ? e.message : String(e);
}
