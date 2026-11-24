/**
 * The beacon collector's reply when some writes failed (app/api/v1/collect).
 *
 * track.js sends a batch again when the reply is 5xx (or the request fails),
 * and nothing dedupes a re-sent batch (pm_events ids are minted per request).
 * So a 503 ("send it again") is right only when nothing from the batch was
 * stored and every failure certainly wrote nothing; otherwise the reply is 200,
 * because losing a batch beats double-counting it.
 *
 * Errors are matched by name, not instanceof: route handlers and the framework
 * client can be separate module instances. Plain module: unit-tested.
 */

import { isDuplicateKeyError } from './ingest-ids';

const prop = (e: unknown, k: string): unknown => (e && typeof e === 'object' ? (e as Record<string, unknown>)[k] : undefined);

/**
 * True when a failed write certainly stored nothing:
 *  - skipped before it started (NotAttemptedError);
 *  - the connection was refused (the request never reached the engine);
 *  - the engine rejected the statement: a duplicate-key or capacity message
 *    (the engine rejects a statement as a whole), or a 4xx answer other than
 *    408/409.
 * Resets, timeouts (ETIMEDOUT) and other engine 5xx are ambiguous: the
 * statement may have run.
 */
export function failedWithoutWriting(err: unknown): boolean {
  const name = prop(err, 'name');
  if (name === 'NotAttemptedError') return true;
  if (name === 'SynapCoresUnavailableError') return prop(err, 'code') === 'ECONNREFUSED';
  if (name === 'SynapCoresError') {
    const message = String(prop(err, 'message') ?? '');
    if (isDuplicateKeyError(err) || /queue capacity is exhausted/i.test(message)) return true;
    const status = prop(err, 'status');
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 409;
  }
  return false;
}

export interface CollectOutcome {
  /** pm_events rows stored. */
  stored: number;
  /** Warehouse rows written (clickstream + identity + conversions). */
  ingested: number;
  /** Errors from the writes that failed. */
  failures: unknown[];
}

/** 'retry' = answer 503 so the pixel sends the batch again; 'ok' = answer 200. */
export function collectReply(o: CollectOutcome): 'ok' | 'retry' {
  if (o.failures.length === 0 || o.stored > 0 || o.ingested > 0) return 'ok';
  return o.failures.every(failedWithoutWriting) ? 'retry' : 'ok';
}
