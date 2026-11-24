/**
 * Auto-retry policy for the error screens (components/EngineReconnect.tsx).
 *
 * A failed page load (usually the analytics engine restarting) is retried by
 * reloading the page after a short countdown, a few times, then the screen
 * waits for "Try again". The attempt count survives the reloads in
 * sessionStorage, per page; a series that has been quiet for a few minutes
 * starts over. Plain module: no React, no DOM.
 */

/** Countdown (seconds) before automatic retry 1, 2, ...; its length is the cap. */
export const RECONNECT_DELAYS_S: readonly number[] = [3, 5, 8, 13];

/** A retry series with no attempt for this long starts over (a page load can take up to ~75 s on a hung engine). */
export const RECONNECT_SERIES_TTL_MS = 3 * 60_000;

export const RECONNECT_STORAGE_KEY = 'mp:reconnect';

export interface ReconnectState {
  /** Page the series belongs to (pathname + search). */
  page: string;
  /** Automatic retries already made. */
  n: number;
  /** When the last one started (epoch ms). */
  at: number;
}

export function parseReconnectState(raw: string | null | undefined): ReconnectState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ReconnectState>;
    if (typeof v.page !== 'string' || typeof v.n !== 'number' || typeof v.at !== 'number') return null;
    if (!Number.isFinite(v.n) || v.n < 0 || !Number.isFinite(v.at)) return null;
    return { page: v.page, n: Math.floor(v.n), at: v.at };
  } catch {
    return null;
  }
}

/** Automatic retries already made for `page` in the current series (0 = fresh series). */
export function retriesSoFar(state: ReconnectState | null, page: string, now: number): number {
  if (!state || state.page !== page) return 0;
  if (now - state.at > RECONNECT_SERIES_TTL_MS || now < state.at) return 0;
  return state.n;
}

/** Countdown before the next automatic retry, or null once the cap is reached. */
export function nextRetryDelayS(retriesMade: number): number | null {
  return retriesMade >= 0 && retriesMade < RECONNECT_DELAYS_S.length ? RECONNECT_DELAYS_S[retriesMade]! : null;
}
