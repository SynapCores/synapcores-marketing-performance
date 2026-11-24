'use client';

/**
 * Error screen for the app's error boundaries (app/error.tsx,
 * app/(app)/error.tsx, app/global-error.tsx). A page usually fails because
 * the analytics engine is restarting (the server already waited ~12 s for it),
 * so the screen says so, reloads the page by itself after a short countdown a
 * few times (lib/reconnect-policy.ts), then waits for "Try again".
 * It never shows the error message, stack or digest.
 */

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  isEngineUnavailableDigest,
} from '@synapcores/app-framework';
import {
  RECONNECT_DELAYS_S,
  RECONNECT_STORAGE_KEY,
  nextRetryDelayS,
  parseReconnectState,
  retriesSoFar,
} from '@/lib/reconnect-policy';

type Props = {
  error: Error & { digest?: string };
  /** Fill the viewport (no app chrome around it). */
  fullScreen?: boolean;
};

function currentPage(): string {
  return window.location.pathname + window.location.search;
}

/** Load the page again with a GET (reload() would re-POST a form submission). */
function reloadPage(): void {
  window.location.replace(currentPage());
}

/** Automatic retries made so far for `page`; null when sessionStorage is blocked (then none: a reload couldn't count them). */
function readRetries(page: string): number | null {
  try {
    return retriesSoFar(parseReconnectState(window.sessionStorage.getItem(RECONNECT_STORAGE_KEY)), page, Date.now());
  } catch {
    return null;
  }
}

function writeRetries(page: string, n: number): boolean {
  try {
    window.sessionStorage.setItem(RECONNECT_STORAGE_KEY, JSON.stringify({ page, n, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function EngineReconnect({ error, fullScreen = false }: Props) {
  const engine = isEngineUnavailableDigest(error.digest);
  // null before mount; seconds until the automatic retry; -1 = no more automatic retries.
  const [left, setLeft] = useState<number | null>(null);
  const [made, setMade] = useState(0);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    const page = currentPage();
    const n = readRetries(page);
    const delay = n === null ? null : nextRetryDelayS(n);
    if (n === null || delay === null) {
      setLeft(-1);
      return;
    }
    setMade(n);
    setLeft(delay);
    const started = Date.now();
    const timer = setInterval(() => {
      const remaining = delay - Math.floor((Date.now() - started) / 1000);
      if (remaining > 0) {
        setLeft(remaining);
        return;
      }
      clearInterval(timer);
      if (writeRetries(page, n + 1)) {
        setReloading(true);
        reloadPage();
      } else {
        setLeft(-1);
      }
    }, 250);
    return () => clearInterval(timer);
  }, []);

  function tryAgain(): void {
    writeRetries(currentPage(), 0); // a manual retry starts a fresh series of automatic ones
    setReloading(true);
    reloadPage();
  }

  const gaveUp = left === -1 && !reloading;
  const title = gaveUp
    ? engine
      ? "The analytics engine isn't back yet"
      : "This page couldn't load"
    : engine
      ? 'Reconnecting to the analytics engine…'
      : 'Reloading this page…';
  const description = engine
    ? 'It restarts now and then to keep its memory in check, and is usually back within a few seconds.'
    : 'Something went wrong while loading it.';
  const status = reloading
    ? 'Reloading…'
    : left === null
      ? 'Retrying shortly…'
      : left > 0
        ? `Trying again in ${left} s (attempt ${made + 1} of ${RECONNECT_DELAYS_S.length})`
        : 'Give it a moment, then try again.';
  // Screen readers hear state changes only, not every tick of the countdown.
  const announcement = reloading
    ? 'Reloading the page.'
    : left === null
      ? ''
      : left > 0
        ? `Retrying automatically, attempt ${made + 1} of ${RECONNECT_DELAYS_S.length}.`
        : 'Automatic retries stopped. Use Try again.';

  return (
    <div
      className={cn(
        'flex items-center justify-center px-4 py-10',
        fullScreen ? 'min-h-screen supports-[height:100dvh]:min-h-dvh' : 'min-h-[50vh]',
      )}
    >
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mb-3 flex justify-center">
            <div className="rounded-full bg-primary/10 p-3">
              <RefreshCw
                aria-hidden="true"
                className={cn('h-7 w-7 text-primary', !gaveUp && 'animate-spin motion-reduce:animate-none')}
              />
            </div>
          </div>
          <CardTitle className="text-xl leading-snug">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>
          <p aria-hidden="true" className="text-center text-sm text-muted-foreground">
            {status}
          </p>
          <Button type="button" size="lg" className="w-full" onClick={tryAgain} disabled={reloading}>
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
