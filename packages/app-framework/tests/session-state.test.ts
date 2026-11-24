import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_LOOKUP_FAILED, SessionUnavailableError, frameworkSessionOf } from '../src/auth/session-state';
import { ENGINE_UNAVAILABLE_DIGEST, isEngineUnavailableDigest } from '../src/db/unavailable';
import type { Session } from '../src/auth/types';

const session = {
  user: { id: 'u1', email: 'u1@example.com', name: null, emailVerified: true, createdAt: '2026-11-01T00:00:00Z' },
  tenant: null,
  role: null,
  permissions: [],
  memberships: [],
} as unknown as Session;

test('frameworkSessionOf: no session vs a session vs a failed lookup', () => {
  assert.equal(frameworkSessionOf(null), null, 'signed out: Auth.js returns null');
  assert.equal(frameworkSessionOf(undefined), null);
  assert.equal(frameworkSessionOf({ user: {} }), null, 'cookie without a framework session');
  assert.equal(frameworkSessionOf({ framework: null }), null, 'user no longer exists');
  assert.equal(frameworkSessionOf({ framework: session }), session);

  // The engine was unreachable while resolving the session: not "signed out".
  assert.throws(
    () => frameworkSessionOf({ framework: null, frameworkError: SESSION_LOOKUP_FAILED }),
    (err: unknown) => err instanceof SessionUnavailableError && err.digest === ENGINE_UNAVAILABLE_DIGEST,
  );
});

test('engine-unavailable digest: recognised with or without a Next error-code suffix, nothing else', () => {
  assert.equal(isEngineUnavailableDigest(ENGINE_UNAVAILABLE_DIGEST), true);
  assert.equal(isEngineUnavailableDigest(`${ENGINE_UNAVAILABLE_DIGEST}@E394`), true);
  assert.equal(isEngineUnavailableDigest('3271148773'), false, 'an ordinary hashed digest');
  assert.equal(isEngineUnavailableDigest(`${ENGINE_UNAVAILABLE_DIGEST}X`), false);
  assert.equal(isEngineUnavailableDigest(undefined), false);
  assert.equal(isEngineUnavailableDigest(''), false);
});

test('attachFrameworkSession: attaches the session, or flags a failed lookup without throwing', async () => {
  const { attachFrameworkSession } = await import('../src/auth/session-state');
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  const ok: { framework?: Session | null; frameworkError?: string } = {};
  await attachFrameworkSession(ok, async () => session, warn);
  // An allow-listed copy (see publicFrameworkSession), equal in content.
  assert.deepEqual(ok.framework, session);
  assert.equal(ok.frameworkError, undefined);
  assert.deepEqual(frameworkSessionOf(ok), session);

  const gone: { framework?: Session | null; frameworkError?: string } = {};
  await attachFrameworkSession(gone, async () => null, warn);
  assert.equal(frameworkSessionOf(gone), null, 'user deleted: signed out');

  const down: { framework?: Session | null; frameworkError?: string } = {};
  const refused = Object.assign(new Error('SynapCores POST /v1/query/prepare: no response (ECONNREFUSED)'), {
    name: 'SynapCoresUnavailableError',
    code: 'ECONNREFUSED',
  });
  await attachFrameworkSession(down, async () => {
    throw refused;
  }, warn);
  assert.equal(down.framework, null);
  assert.equal(down.frameworkError, SESSION_LOOKUP_FAILED);
  assert.throws(() => frameworkSessionOf(down), SessionUnavailableError);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^\[auth\] session lookup failed, keeping the session: SynapCoresUnavailableError ECONNREFUSED: /);
  assert.ok(!/\n\s+at /.test(warnings[0]!), 'no stack in the log line');
});
