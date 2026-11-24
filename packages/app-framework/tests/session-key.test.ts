import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  frameworkJwtCallback,
  frameworkSessionCallback,
  frameworkSessionOf,
  publicFrameworkSession,
} from '../src/auth/session-state';
import {
  TenantKeyMissingError,
  hasTenantApiKey,
  readTenantApiKey,
  requireTenantApiKey,
} from '../src/auth/tenant-keys';
import type { Session } from '../src/auth/types';

// A key shaped like the real ones (46 chars). Every "no key" check below compares
// by VALUE against the serialized output, not just by field name.
const KEY = `sk_${randomBytes(32).toString('base64url')}`;
const TENANT = '5d2f6c1e-8a4b-4c3d-9e2f-1a2b3c4d5e6f';
const OTHER_TENANT = '0b9e7d6c-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const UNKNOWN_TENANT = '7f3e2d1c-0b9a-4867-a564-738291a0b0c0';
const USER = { id: 'u1', email: 'owner@example.com', name: 'Owner', emailVerified: true, createdAt: '2026-11-01T00:00:00Z' };

/** A framework session as an older resolver (or a regression) would produce it: keys on every tenant object. */
function sessionWithKeys(): Session {
  return {
    user: USER,
    tenant: { id: TENANT, name: 'Acme', slug: 'acme', apiKey: KEY },
    role: 'owner',
    permissions: ['audit:read', 'members:invite'],
    memberships: [
      { tenant: { id: TENANT, name: 'Acme', slug: 'acme', apiKey: KEY }, role: 'owner' },
      { tenant: { id: OTHER_TENANT, name: 'Beta', slug: 'beta', apiKey: '' }, role: 'viewer' },
    ],
  } as unknown as Session;
}

test('session callback: the output (GET /api/auth/session, auth()) carries no tenant API key, by value', async () => {
  const authjsSession = { user: { name: 'Owner', email: 'owner@example.com', image: null }, expires: '2026-12-24T00:00:00.000Z' };
  // A token minted by older code could hold the key too; the callback reads only userId from it.
  const oldToken = { sub: 'u1', userId: 'u1', apiKey: KEY, framework: { tenant: { apiKey: KEY } } };
  const asked: string[] = [];
  const out = await frameworkSessionCallback(authjsSession, oldToken, async (userId) => {
    asked.push(userId);
    return sessionWithKeys();
  });

  assert.deepEqual(asked, ['u1'], 'resolved for the token user');
  const wire = JSON.stringify(out);
  assert.equal(wire.includes(KEY), false, 'the key value appears nowhere in the session output');
  assert.equal(wire.includes('apiKey'), false, 'no apiKey field either');

  // Everything the app reads is still there.
  const fw = frameworkSessionOf(out);
  assert.ok(fw);
  assert.deepEqual(fw.user, USER);
  assert.deepEqual(fw.tenant, { id: TENANT, name: 'Acme', slug: 'acme' });
  assert.equal(fw.role, 'owner');
  assert.deepEqual(fw.permissions, ['audit:read', 'members:invite']);
  assert.deepEqual(fw.memberships, [
    { tenant: { id: TENANT, name: 'Acme', slug: 'acme' }, role: 'owner' },
    { tenant: { id: OTHER_TENANT, name: 'Beta', slug: 'beta' }, role: 'viewer' },
  ]);
  assert.deepEqual((out as { user: unknown }).user, authjsSession.user, 'Auth.js fields untouched');
});

test('session callback: no user id → no framework session; failed lookup → flagged, still no key', async () => {
  const anon = await frameworkSessionCallback({ expires: 'x' }, { apiKey: KEY }, async () => sessionWithKeys());
  assert.equal(JSON.stringify(anon).includes(KEY), false);
  assert.equal(frameworkSessionOf(anon), null);

  const down = await frameworkSessionCallback({ expires: 'x' }, { userId: 'u1', apiKey: KEY }, async () => {
    throw Object.assign(new Error('no response (ECONNREFUSED)'), { code: 'ECONNREFUSED' });
  });
  assert.equal(JSON.stringify(down).includes(KEY), false);
  assert.throws(() => frameworkSessionOf(down), /could not be resolved/);
});

test('publicFrameworkSession: allow-list keeps the Session shape and drops anything else', () => {
  assert.equal(publicFrameworkSession(null), null);
  const extra = { ...sessionWithKeys(), secret: KEY, user: { ...USER, password_hash: KEY } } as unknown as Session;
  const pub = publicFrameworkSession(extra)!;
  assert.equal(JSON.stringify(pub).includes(KEY), false);
  assert.deepEqual(Object.keys(pub).sort(), ['memberships', 'permissions', 'role', 'tenant', 'user']);
  assert.deepEqual(pub.user, USER);
});

test('jwt callback: the cookie token holds the user id, never tenant data or keys (old tokens are cleaned)', () => {
  // Sign-in: Auth.js hands over its default claims plus the user.
  const fresh = frameworkJwtCallback({ name: 'Owner', email: 'owner@example.com', picture: null, sub: 'u1' }, { id: 'u1' });
  assert.deepEqual(fresh, { name: 'Owner', email: 'owner@example.com', picture: null, sub: 'u1', userId: 'u1' });

  // Every later read: a token from older code that carried tenant data/keys loses them.
  const old = {
    name: 'Owner', email: 'owner@example.com', sub: 'u1', userId: 'u1', iat: 1, exp: 2, jti: 'j',
    apiKey: KEY,
    tenant: { id: TENANT, apiKey: KEY },
    framework: { tenant: { id: TENANT, apiKey: KEY } },
    frameworkError: 'session_lookup_failed',
    memberships: [{ tenant: { id: TENANT, apiKey: KEY } }],
  };
  const cleaned = frameworkJwtCallback(old);
  assert.equal(JSON.stringify(cleaned).includes(KEY), false, 'the key value is gone from the token');
  assert.deepEqual(Object.keys(cleaned).sort(), ['email', 'exp', 'iat', 'jti', 'name', 'sub', 'userId']);
  assert.equal(old.apiKey, KEY, 'the input token object is not mutated');

  // A session update (POST /api/auth/session) calls the jwt callback with no user:
  // the user id can't be changed that way, and nothing is added.
  const updated = frameworkJwtCallback({ sub: 'u1', userId: 'u1' }, undefined);
  assert.deepEqual(updated, { sub: 'u1', userId: 'u1' });
});

// ── server-side key store ───────────────────────────────────────────────────

function keyStore() {
  const base = mkdtempSync(join(tmpdir(), 'tenant-keys-test-'));
  after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'keys');
  mkdirSync(dir);
  writeFileSync(join(dir, `${TENANT}.key`), `${KEY}\n`, { mode: 0o600 });
  writeFileSync(join(dir, `${OTHER_TENANT}.key`), '  \n', { mode: 0o600 }); // provisioned but empty
  writeFileSync(join(base, 'outside.key'), KEY, { mode: 0o600 }); // reachable only via a traversal
  return dir;
}

test('tenant key lookup: returns the tenant key server-side; fails closed for unknown or malformed tenants', async () => {
  const dir = keyStore();
  assert.equal((await readTenantApiKey(TENANT, dir)) === KEY, true, 'the tenant key, trimmed');
  assert.equal(await hasTenantApiKey(TENANT, dir), true);

  assert.equal(await readTenantApiKey(UNKNOWN_TENANT, dir), null, 'unknown tenant');
  assert.equal(await hasTenantApiKey(UNKNOWN_TENANT, dir), false);
  assert.equal(await readTenantApiKey(OTHER_TENANT, dir), null, 'empty key file = no key');
  assert.equal(await readTenantApiKey(TENANT, join(dir, 'missing-dir')), null, 'missing store');

  for (const bad of ['', '.', '..', '../outside', '..\\outside', 'a/b', `${TENANT}/../../outside`, 'a.b', ' x', 'x\u0000', 'x'.repeat(129)]) {
    assert.equal(await readTenantApiKey(bad, dir), null, `malformed id ${JSON.stringify(bad.slice(0, 20))}`);
  }
  assert.equal(await readTenantApiKey(undefined as unknown as string, dir), null);

  await assert.rejects(requireTenantApiKey(UNKNOWN_TENANT, dir), (err: unknown) => {
    assert.ok(err instanceof TenantKeyMissingError);
    assert.equal(err.message.includes(UNKNOWN_TENANT), false, 'the error names no tenant');
    assert.equal(err.message.includes(KEY), false);
    return true;
  });
  assert.equal((await requireTenantApiKey(TENANT, dir)) === KEY, true);

  const prev = process.env.FRAMEWORK_TENANT_KEYS_DIR;
  process.env.FRAMEWORK_TENANT_KEYS_DIR = dir;
  try {
    assert.equal((await readTenantApiKey(TENANT)) === KEY, true, 'default store = FRAMEWORK_TENANT_KEYS_DIR');
  } finally {
    if (prev === undefined) delete process.env.FRAMEWORK_TENANT_KEYS_DIR;
    else process.env.FRAMEWORK_TENANT_KEYS_DIR = prev;
  }
});

// ── db/server.ts: tenant-scoped clients get the key by tenant id ────────────

/** Load ../src/db/server with its `server-only` marker stubbed (the real one throws outside React Server). */
function loadDbServer(): typeof import('../src/db/server') {
  const NodeModule = require('node:module') as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
  };
  const STUB = 'server-only';
  const stub = new NodeModule(STUB);
  stub.filename = STUB;
  stub.loaded = true;
  stub.exports = {};
  (require.cache as Record<string, unknown>)[STUB] = stub;
  const orig = NodeModule._resolveFilename;
  NodeModule._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === STUB ? STUB : orig.call(this, request, ...rest);
  };
  try {
    return require('../src/db/server') as typeof import('../src/db/server');
  } finally {
    NodeModule._resolveFilename = orig;
  }
}

test('getClientForSession: queries with the key read by the tenant id, never one from the session; fails closed without one', async () => {
  const dir = keyStore();
  const dbServer = loadDbServer();
  const { getClientForSession } = dbServer;
  assert.equal('getClientForTenant' in dbServer, false, 'no exported "client for any tenant id"');
  const prevDir = process.env.FRAMEWORK_TENANT_KEYS_DIR;
  const prevUrl = process.env.SYNAPCORES_URL;
  process.env.FRAMEWORK_TENANT_KEYS_DIR = dir;
  process.env.SYNAPCORES_URL = 'http://127.0.0.1:59999';
  const auths: Array<string | null> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    auths.push(new Headers(init?.headers).get('authorization'));
    return new Response(JSON.stringify({ data: { columns: [{ name: 'n', data_type: 'INTEGER', nullable: false }], rows: [[1]] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const session: Session = {
      user: USER,
      tenant: { id: TENANT, name: 'Acme', slug: 'acme' },
      role: 'owner',
      permissions: [],
      memberships: [],
    } as unknown as Session;
    await (await getClientForSession(session)).sql('SELECT 1');
    assert.equal(auths.length, 1);
    assert.equal(auths[0] === `Bearer ${KEY}`, true, 'the request carries the tenant key from the server-side store');

    // A stale key on an old-shape session object is ignored: the key comes from the store.
    const oldShape = { ...session, tenant: { id: TENANT, name: 'Acme', slug: 'acme', apiKey: 'stale-session-value' } } as unknown as Session;
    await (await getClientForSession(oldShape)).sql('SELECT 1');
    assert.equal(auths[1] === `Bearer ${KEY}`, true, 'session client uses the store, not the session');

    const withTenant = (id: string) => ({ ...session, tenant: { id, name: 'x', slug: 'x' } }) as Session;
    await assert.rejects(getClientForSession(withTenant(UNKNOWN_TENANT)), (err: unknown) => {
      assert.ok(err instanceof TenantKeyMissingError, 'unknown tenant');
      assert.equal(String((err as Error).message).includes(UNKNOWN_TENANT), false, 'the error names no tenant');
      return true;
    });
    await assert.rejects(getClientForSession(withTenant(OTHER_TENANT)), TenantKeyMissingError, 'empty key file');
    await assert.rejects(getClientForSession(withTenant('../outside')), TenantKeyMissingError, 'traversal id');
    await assert.rejects(getClientForSession({ ...session, tenant: null }), /session has no tenant/);
    assert.equal(auths.length, 2, 'no engine request is made without a key');
  } finally {
    globalThis.fetch = realFetch;
    if (prevDir === undefined) delete process.env.FRAMEWORK_TENANT_KEYS_DIR;
    else process.env.FRAMEWORK_TENANT_KEYS_DIR = prevDir;
    if (prevUrl === undefined) delete process.env.SYNAPCORES_URL;
    else process.env.SYNAPCORES_URL = prevUrl;
  }
});
