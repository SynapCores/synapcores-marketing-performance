import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectReply, failedWithoutWriting } from '../src/lib/collect-outcome';
import { NotAttemptedError } from '../src/lib/ingest-ids';

// Shapes as the framework client throws them (matched by name, not instanceof).
const engineError = (status: number, message: string) => Object.assign(new Error(message), { name: 'SynapCoresError', status });
const unavailable = (code: string) => Object.assign(new Error(`no response (${code})`), { name: 'SynapCoresUnavailableError', code });
const DUP = "Query operation error: Batch error: Constraint violation: Duplicate key: row violates a UNIQUE or PRIMARY KEY constraint on table 'recipe_pm_click_events'";

test('failedWithoutWriting: certain no-writes vs ambiguous failures', () => {
  // certainly nothing written → a re-send is safe
  assert.equal(failedWithoutWriting(new NotAttemptedError('deadline passed')), true);
  assert.equal(failedWithoutWriting(unavailable('ECONNREFUSED')), true);
  assert.equal(failedWithoutWriting(engineError(400, DUP)), true);
  assert.equal(failedWithoutWriting(engineError(500, DUP)), true, 'duplicate key arriving as a 5xx');
  assert.equal(failedWithoutWriting(engineError(429, 'SQL concurrency or queue capacity is exhausted; retry later')), true);
  assert.equal(failedWithoutWriting(engineError(400, 'Query operation error: parse error')), true);
  assert.equal(failedWithoutWriting(engineError(401, 'unauthorized')), true);
  // may have run → no re-send
  assert.equal(failedWithoutWriting(unavailable('ECONNRESET')), false);
  assert.equal(failedWithoutWriting(unavailable('UND_ERR_SOCKET')), false);
  assert.equal(failedWithoutWriting(unavailable('ETIMEDOUT')), false);
  assert.equal(failedWithoutWriting(engineError(500, 'Native commit did not confirm its outcome')), false);
  assert.equal(failedWithoutWriting(engineError(408, 'timeout')), false);
  assert.equal(failedWithoutWriting(engineError(409, 'conflict')), false);
  assert.equal(failedWithoutWriting(new TypeError('enrichment bug')), false);
  assert.equal(failedWithoutWriting(undefined), false);
});

test('collectReply: 503 only when nothing landed and every failure certainly wrote nothing', () => {
  assert.equal(collectReply({ stored: 3, ingested: 1, failures: [] }), 'ok');
  assert.equal(collectReply({ stored: 0, ingested: 0, failures: [] }), 'ok', 'an empty batch');
  // pm_events failed for a click-only batch: previously a silent 200 → lost
  assert.equal(collectReply({ stored: 0, ingested: 0, failures: [unavailable('ECONNREFUSED')] }), 'retry');
  assert.equal(collectReply({ stored: 0, ingested: 0, failures: [engineError(429, 'queue capacity is exhausted'), new NotAttemptedError('deadline passed')] }), 'retry');
  // something landed: a re-send would duplicate it
  assert.equal(collectReply({ stored: 2, ingested: 0, failures: [engineError(400, DUP)] }), 'ok');
  assert.equal(collectReply({ stored: 0, ingested: 1, failures: [unavailable('ECONNREFUSED')] }), 'ok');
  // one failure may have written: never ask for a re-send
  assert.equal(collectReply({ stored: 0, ingested: 0, failures: [unavailable('ECONNREFUSED'), unavailable('ECONNRESET')] }), 'ok');
  assert.equal(collectReply({ stored: 0, ingested: 0, failures: [unavailable('ETIMEDOUT')] }), 'ok');
});
