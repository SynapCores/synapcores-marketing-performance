/** Hydration gate (src/app/hydration-gate.ts): webpack chunk processing waits for `load`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { HYDRATION_GATE_SCRIPT, WEBPACK_CHUNK_GLOBAL } from '../src/app/hydration-gate';

function sandbox(readyState: string) {
  const listeners: Record<string, Array<() => void>> = {};
  const timers: Array<() => void> = [];
  const doc = { readyState, addEventListener: (t: string, f: () => void) => (listeners['doc:' + t] ??= []).push(f) };
  const ctx: Record<string, unknown> = {
    document: doc,
    addEventListener: (t: string, f: () => void) => (listeners['win:' + t] ??= []).push(f),
    setTimeout: (f: () => void) => timers.push(f),
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(HYDRATION_GATE_SCRIPT, ctx);
  return { ctx, fire: (k: string) => (listeners[k] ?? []).forEach((f) => f()), timers };
}

/** Mimics the tail of Next's webpack runtime: drain early chunks, then hook push. */
function runWebpackRuntime(ctx: Record<string, unknown>, seen: unknown[]) {
  const o = ((ctx as Record<string, unknown[]>)[WEBPACK_CHUNK_GLOBAL] ??= []) as unknown[] & { push: (...a: unknown[]) => number };
  const cb = (parentPush: ((...a: unknown[]) => number) | 0, chunk: unknown) => {
    seen.push(chunk);
    if (parentPush) parentPush(chunk);
  };
  o.forEach((c) => cb(0, c));
  o.push = ((parent) => (c: unknown) => (cb(parent, c), o.length))(o.push.bind(o));
}

test('chunks pushed before and after the runtime wait for load, in order', () => {
  const { ctx, fire } = sandbox('loading');
  const q = ctx[WEBPACK_CHUNK_GLOBAL] as unknown[];
  q.push('early-1');
  q.push('early-2');
  const seen: unknown[] = [];
  runWebpackRuntime(ctx, seen);
  (ctx[WEBPACK_CHUNK_GLOBAL] as unknown[]).push('late-1');
  assert.deepEqual(seen, []); // nothing executes (so nothing hydrates) yet
  fire('win:load');
  assert.deepEqual(seen, ['early-1', 'early-2', 'late-1']);
  (ctx[WEBPACK_CHUNK_GLOBAL] as unknown[]).push('after-load');
  assert.deepEqual(seen.at(-1), 'after-load'); // gate open: straight through
});

test('a slow load is capped: released after DOMContentLoaded + timeout', () => {
  const { ctx, fire, timers } = sandbox('loading');
  const seen: unknown[] = [];
  (ctx[WEBPACK_CHUNK_GLOBAL] as unknown[]).push('a');
  runWebpackRuntime(ctx, seen);
  fire('doc:DOMContentLoaded');
  assert.deepEqual(seen, []);
  timers.forEach((f) => f());
  assert.deepEqual(seen, ['a']);
});

test('no-op once the document is complete', () => {
  const { ctx } = sandbox('complete');
  const seen: unknown[] = [];
  (ctx[WEBPACK_CHUNK_GLOBAL] = ['x']);
  runWebpackRuntime(ctx, seen);
  assert.deepEqual(seen, ['x']);
});

test('the built webpack runtime uses the chunk global the gate hooks', (t) => {
  const dir = join(__dirname, '..', '..', '.next', 'static', 'chunks');
  const alt = join(__dirname, '..', '.next', 'static', 'chunks');
  const d = existsSync(dir) ? dir : alt;
  const f = existsSync(d) ? readdirSync(d).find((n) => /^webpack-.*\.js$/.test(n)) : undefined;
  if (!f) return t.skip('no next build present');
  assert.ok(readFileSync(join(d, f), 'utf8').includes(`self.${WEBPACK_CHUNK_GLOBAL}=self.${WEBPACK_CHUNK_GLOBAL}||[]`));
});
