import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECT_RETRY_BUDGET_MS,
  CONNECT_RETRY_DELAYS_MS,
  ENGINE_DOWN_HOLD_MS,
  connectRetryDelay,
  isConnectionRefused,
  markEngineDown,
  newEngineBreaker,
  retryBudgetFor,
  transportErrorCode,
  withConnectRetry,
  type EngineBreaker,
} from '../src/db/retry';
import { SynapCoresClient, SynapCoresError, SynapCoresUnavailableError } from '../src/db/client';
import { ENGINE_UNAVAILABLE_DIGEST, isEngineUnavailableDigest } from '../src/db/unavailable';

// Shapes Node actually produces: undici's fetch wraps the socket error in `cause`;
// node:http hands the socket error over directly; several addresses → AggregateError.
const sockErr = (code: string) => Object.assign(new Error(`connect ${code} 127.0.0.1:18420`), { code });
const fetchFailed = (code: string) => new TypeError('fetch failed', { cause: sockErr(code) });
const aggregate = (...codes: string[]) =>
  Object.assign(new AggregateError(codes.map(sockErr), 'connect failed'), { code: codes[0] });
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

test('refused connections are recognised (incl. through causes); resets, timeouts and HTTP errors are not', () => {
  assert.equal(isConnectionRefused(fetchFailed('ECONNREFUSED')), true);
  assert.equal(isConnectionRefused(sockErr('ECONNREFUSED')), true);
  assert.equal(isConnectionRefused(aggregate('ECONNREFUSED', 'ECONNREFUSED')), true);
  assert.equal(isConnectionRefused(new SynapCoresUnavailableError('x', 'ECONNREFUSED')), true);

  assert.equal(isConnectionRefused(aggregate('ECONNREFUSED', 'ETIMEDOUT')), false, 'every address must have refused');
  assert.equal(isConnectionRefused(fetchFailed('ECONNRESET')), false);
  assert.equal(isConnectionRefused(fetchFailed('UND_ERR_SOCKET')), false);
  assert.equal(isConnectionRefused(fetchFailed('EPIPE')), false);
  assert.equal(isConnectionRefused(abortError()), false);
  assert.equal(isConnectionRefused(new SynapCoresError(429, 'SQL concurrency or queue capacity is exhausted; retry later')), false);
  assert.equal(isConnectionRefused(new SynapCoresError(503, 'unavailable')), false);
  assert.equal(isConnectionRefused(undefined), false);
  assert.equal(isConnectionRefused('ECONNREFUSED'), false);

  assert.equal(transportErrorCode(fetchFailed('ECONNRESET')), 'ECONNRESET');
  assert.equal(transportErrorCode(sockErr('ECONNREFUSED')), 'ECONNREFUSED');
  assert.equal(transportErrorCode(new Error('plain')), undefined);
});

test('retry delays: short backoff with jitter, only for refusals, within the ~12 s budget', () => {
  const mid = () => 0.5; // no jitter
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((n) => connectRetryDelay(sockErr('ECONNREFUSED'), n, 0, CONNECT_RETRY_BUDGET_MS, mid)),
    [100, 250, 500, 1000, 1500, 1500, 1500],
  );
  assert.equal(connectRetryDelay(sockErr('ECONNREFUSED'), 1, 0, CONNECT_RETRY_BUDGET_MS, () => 0), 80);
  assert.equal(connectRetryDelay(sockErr('ECONNREFUSED'), 5, 0, CONNECT_RETRY_BUDGET_MS, () => 0.999999), 1800);
  assert.equal(connectRetryDelay(fetchFailed('ECONNRESET'), 1, 0), null, 'a reset may have run the statement');
  assert.equal(connectRetryDelay(abortError(), 1, 0), null, 'a timeout may have run the statement');
  assert.equal(connectRetryDelay(sockErr('ECONNREFUSED'), 9, 11_000, CONNECT_RETRY_BUDGET_MS, mid), null, 'budget spent');

  // Whole schedule: how long a request keeps trying while nothing listens.
  for (const r of [0, 0.5, 0.999999]) {
    let elapsed = 0;
    let attempts = 1;
    for (;;) {
      const d = connectRetryDelay(sockErr('ECONNREFUSED'), attempts, elapsed, CONNECT_RETRY_BUDGET_MS, () => r);
      if (d === null) break;
      elapsed += d;
      attempts += 1;
    }
    assert.ok(elapsed <= CONNECT_RETRY_BUDGET_MS, `waits at most the budget (random=${r}: ${elapsed} ms)`);
    assert.ok(elapsed >= 10_000, `keeps trying well past the ~5 s restart gap (random=${r}: ${elapsed} ms)`);
    assert.ok(attempts >= 8 && attempts <= 14, `attempts=${attempts}`);
  }
  assert.equal(CONNECT_RETRY_DELAYS_MS[0], 100);
});

test('withConnectRetry re-runs the unit while the engine refuses, and returns once it is back', async () => {
  const clock = fakeClock();
  const backAt = clock.now() + 5_000; // engine ready again 5 s later
  let calls = 0;
  const retries: number[] = [];
  const out = await withConnectRetry(
    async () => {
      calls += 1;
      if (clock.now() < backAt) throw fetchFailed('ECONNREFUSED');
      return 'rows';
    },
    { now: clock.now, sleep: clock.sleep, random: () => 0.5, onRetry: (i) => retries.push(i.attempt) },
  );
  assert.equal(out, 'rows');
  assert.ok(calls >= 6 && calls <= 9, `calls=${calls}`);
  assert.deepEqual(retries, Array.from({ length: calls - 1 }, (_, i) => i + 1));
  assert.ok(clock.now() - backAt < 1_600, 'resumes within one backoff step of the engine coming back');
});

test('withConnectRetry gives up after the budget with the refusal, and never re-runs other failures', async () => {
  const clock = fakeClock();
  const t0 = clock.now();
  let calls = 0;
  await assert.rejects(
    withConnectRetry(
      async () => {
        calls += 1;
        throw fetchFailed('ECONNREFUSED');
      },
      { now: clock.now, sleep: clock.sleep, random: () => 0.5 },
    ),
    (err: unknown) => isConnectionRefused(err),
  );
  assert.ok(clock.now() - t0 <= CONNECT_RETRY_BUDGET_MS);
  assert.ok(calls > 5, `calls=${calls}`);

  for (const failure of [fetchFailed('ECONNRESET'), abortError(), new SynapCoresError(400, 'bad sql')]) {
    let n = 0;
    await assert.rejects(
      withConnectRetry(
        async () => {
          n += 1;
          throw failure;
        },
        { now: clock.now, sleep: clock.sleep },
      ),
      (err: unknown) => err === failure,
    );
    assert.equal(n, 1, `not retried: ${(failure as Error).message}`);
  }
});

// ── SynapCoresClient with a scripted fetch ──────────────────────────────────

type Step = (url: string, body: Record<string, unknown>) => Response | Promise<Response>;
const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const rowsOf = (n: number) => json(200, { data: { columns: [{ name: 'n', data_type: 'INTEGER', nullable: false }], rows: [[n]] } });

function scriptedClient(steps: Step[], opts: { breaker?: EngineBreaker; budgetMs?: number; timeoutMs?: number } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === '/v1/query/close') {
      calls.push({ path, body });
      return json(200, { data: {} });
    }
    calls.push({ path, body });
    const step = steps[i++];
    if (!step) throw new Error(`unexpected request ${path}`);
    return step(path, body);
  }) as typeof fetch;
  const client = new SynapCoresClient({
    baseUrl: 'http://127.0.0.1:18420',
    apiKey: 'test-key',
    fetchImpl,
    engineBreaker: opts.breaker ?? newEngineBreaker(),
    connectRetryBudgetMs: opts.budgetMs,
    timeoutMs: opts.timeoutMs,
  });
  return { client, calls, used: () => i };
}

const refuse: Step = () => {
  throw fetchFailed('ECONNREFUSED');
};

test('client: a statement refused during an engine restart is sent again and succeeds', async () => {
  const { client, calls } = scriptedClient([refuse, refuse, () => rowsOf(7)]);
  const res = await client.sql('SELECT 7 AS n');
  assert.deepEqual(res.rows, [{ n: 7 }]);
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/v1/query/execute', '/v1/query/execute', '/v1/query/execute'],
  );
});

test('client: prepare + exec start over when exec is refused (the old statement died with the engine)', async () => {
  const { client, calls } = scriptedClient([
    () => json(200, { data: { statement_id: 'old', param_count: 1, sql: 'x', database: 'd' } }),
    refuse,
    () => json(200, { data: { statement_id: 'new', param_count: 1, sql: 'x', database: 'd' } }),
    (_p, body) => (body.statement_id === 'new' ? rowsOf(1) : json(404, { error: { message: 'unknown statement' } })),
  ]);
  const res = await client.sql('SELECT $1 AS n', [1]);
  assert.deepEqual(res.rows, [{ n: 1 }]);
  const work = calls.filter((c) => c.path !== '/v1/query/close');
  assert.deepEqual(
    work.map((c) => `${c.path} ${String(c.body.statement_id ?? '')}`.trim()),
    ['/v1/query/prepare', '/v1/query/exec old', '/v1/query/prepare', '/v1/query/exec new'],
  );
});

test('client: a connection reset mid-request is not retried; it surfaces as SynapCoresUnavailableError', async () => {
  const { client, used } = scriptedClient([
    () => {
      throw fetchFailed('ECONNRESET');
    },
  ]);
  await assert.rejects(client.sql("INSERT INTO t VALUES (1)"), (err: unknown) => {
    assert.ok(err instanceof SynapCoresUnavailableError);
    assert.equal(err.code, 'ECONNRESET');
    assert.equal(err.digest, ENGINE_UNAVAILABLE_DIGEST);
    assert.ok(isEngineUnavailableDigest(err.digest));
    assert.ok(!/test-key/.test(err.message), 'no credentials in the message');
    return true;
  });
  assert.equal(used(), 1);

  // The body breaking off after the headers arrived: the statement ran, so no retry either.
  const broken = { ok: true, status: 200, text: () => Promise.reject(fetchFailed('ECONNRESET')) } as unknown as Response;
  const { client: c2, used: used2 } = scriptedClient([() => broken]);
  await assert.rejects(c2.sql('SELECT 1'), (err: unknown) => err instanceof SynapCoresUnavailableError);
  assert.equal(used2(), 1);
});

test('client: HTTP errors keep their behaviour; an AbortError that is not our timeout passes through unchanged', async () => {
  const { client, used } = scriptedClient([() => json(400, { error: { message: 'Query operation error: bad' } })]);
  await assert.rejects(client.sql('SELEC 1'), (err: unknown) => {
    assert.ok(err instanceof SynapCoresError);
    assert.equal(err.status, 400);
    return true;
  });
  assert.equal(used(), 1);

  const { client: c2, used: used2 } = scriptedClient([
    () => json(429, { error: { message: 'SQL concurrency or queue capacity is exhausted; retry later' } }),
  ]);
  await assert.rejects(c2.sql('SELECT 1'), (err: unknown) => err instanceof SynapCoresError && err.status === 429);
  assert.equal(used2(), 1);

  const { client: c3, used: used3 } = scriptedClient([
    () => {
      throw abortError();
    },
  ]);
  await assert.rejects(c3.sql('SELECT 1'), (err: unknown) => (err as Error).name === 'AbortError' && !(err instanceof SynapCoresUnavailableError));
  assert.equal(used3(), 1);
});

test('client: no answer within the timeout → SynapCoresUnavailableError ETIMEDOUT (engine digest), not retried', async () => {
  let calls = 0;
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
      );
    });
  }) as typeof fetch;
  const client = new SynapCoresClient({ apiKey: 'k', fetchImpl, timeoutMs: 30, engineBreaker: newEngineBreaker() });
  const t0 = Date.now();
  await assert.rejects(client.sql('SELECT pg_sleep(100)'), (err: unknown) => {
    assert.ok(err instanceof SynapCoresUnavailableError);
    assert.equal(err.code, 'ETIMEDOUT');
    assert.equal(err.digest, ENGINE_UNAVAILABLE_DIGEST);
    assert.equal((err.cause as Error).name, 'AbortError');
    return true;
  });
  assert.equal(calls, 1, 'a timed-out statement may have run: never re-sent');
  assert.ok(Date.now() - t0 < 1_000);
});

test('client: a failure that is not a transport error (e.g. a bad URL) is rethrown unchanged', async () => {
  const bug = new TypeError('Failed to parse URL from htp:/nope/v1/query/execute');
  const { client, used } = scriptedClient([
    () => {
      throw bug;
    },
  ]);
  await assert.rejects(client.sql('SELECT 1'), (err: unknown) => err === bug);
  assert.equal(used(), 1);
});

test('breaker: once a request has waited out the budget, others try once until the engine answers', async () => {
  const b = newEngineBreaker();
  assert.equal(retryBudgetFor(b, 1_000), CONNECT_RETRY_BUDGET_MS);
  markEngineDown(b, 1_000);
  assert.equal(b.downUntil, 1_000 + ENGINE_DOWN_HOLD_MS);
  assert.equal(retryBudgetFor(b, 1_000 + ENGINE_DOWN_HOLD_MS - 1), 0);
  assert.equal(retryBudgetFor(b, 1_000 + ENGINE_DOWN_HOLD_MS), CONNECT_RETRY_BUDGET_MS);

  // Client: a short budget (300 ms) so the test runs in real time.
  const breaker = newEngineBreaker();
  let up = false;
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (!up) throw fetchFailed('ECONNREFUSED');
    return rowsOf(1);
  }) as unknown as typeof fetch;
  const client = new SynapCoresClient({ apiKey: 'k', fetchImpl, connectRetryBudgetMs: 300, engineBreaker: breaker });

  await assert.rejects(client.sql('SELECT 1'), (err: unknown) => isConnectionRefused(err));
  assert.ok(calls >= 2, `first request kept trying (${calls} attempts)`);
  assert.ok(breaker.downUntil > Date.now(), 'engine now known down');
  assert.ok(breaker.refusedSince > 0);

  calls = 0;
  const t0 = Date.now();
  await assert.rejects(client.sql('SELECT 2'), (err: unknown) => err instanceof SynapCoresUnavailableError && err.code === 'ECONNREFUSED');
  assert.equal(calls, 1, 'while known down: a single attempt, no backoff');
  assert.ok(Date.now() - t0 < 100);

  up = true;
  calls = 0;
  const res = await client.sql('SELECT 1 AS n');
  assert.deepEqual(res.rows, [{ n: 1 }]);
  assert.equal(calls, 1, 'the single attempt notices the engine is back');
  assert.equal(breaker.downUntil, 0);
  assert.equal(breaker.refusedSince, 0);

  // An HTTP error also proves the engine is reachable.
  markEngineDown(breaker, Date.now());
  const { client: c2 } = scriptedClient([() => json(400, { error: { message: 'bad' } })], { breaker });
  await assert.rejects(c2.sql('SELEC 1'));
  assert.equal(breaker.downUntil, 0);
});
