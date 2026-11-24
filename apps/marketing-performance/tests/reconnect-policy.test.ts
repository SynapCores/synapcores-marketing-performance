import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECONNECT_DELAYS_S,
  RECONNECT_SERIES_TTL_MS,
  nextRetryDelayS,
  parseReconnectState,
  retriesSoFar,
} from '../src/lib/reconnect-policy';

test('reconnect state: parsed defensively from sessionStorage', () => {
  assert.deepEqual(parseReconnectState('{"page":"/visitors","n":2,"at":1000}'), { page: '/visitors', n: 2, at: 1000 });
  assert.deepEqual(parseReconnectState('{"page":"/","n":1.7,"at":5}'), { page: '/', n: 1, at: 5 });
  for (const bad of [null, undefined, '', 'nope', '{}', '[]', '{"page":"/","n":-1,"at":1}', '{"page":"/","n":"2","at":1}', '{"page":1,"n":0,"at":1}']) {
    assert.equal(parseReconnectState(bad), null, String(bad));
  }
});

test('reconnect series: counted per page, and a quiet series starts over', () => {
  const at = 1_000_000;
  const s = { page: '/dashboard', n: 2, at };
  assert.equal(retriesSoFar(s, '/dashboard', at + 20_000), 2);
  assert.equal(retriesSoFar(s, '/visitors', at + 20_000), 0, 'another page');
  assert.equal(retriesSoFar(s, '/dashboard', at + RECONNECT_SERIES_TTL_MS + 1), 0, 'expired');
  assert.equal(retriesSoFar(s, '/dashboard', at - 1), 0, 'clock went backwards');
  assert.equal(retriesSoFar(null, '/dashboard', at), 0);
});

test('automatic retries: a few seconds apart, capped', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(nextRetryDelayS), [3, 5, 8, 13, null, null]);
  assert.equal(nextRetryDelayS(-1), null);

  // Simulate the screen: each reload bumps n until the cap; then it waits for "Try again".
  let n = 0;
  let waited = 0;
  for (;;) {
    const d = nextRetryDelayS(n);
    if (d === null) break;
    waited += d;
    n += 1;
  }
  assert.equal(n, RECONNECT_DELAYS_S.length);
  assert.equal(n, 4);
  assert.equal(waited, 29, 'about half a minute of countdowns, plus the page loads in between');
});
