/**
 * public/track.js delivery: backoff, drop-on-4xx, queue cap, single in-flight.
 * Loads the real browser script into a vm sandbox with a fake XHR + clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const SRC = readFileSync(join(__dirname, '..', '..', 'public', 'track.js'), 'utf8');

interface Sent { body: { events: Array<{ name: string }> }; respond(status: number, retryAfter?: string): void }

function load() {
  const sent: Sent[] = [];
  let now = 1_000_000;
  let tick: (() => void) | null = null;
  class FakeXHR {
    status = 0; statusText = ''; response = '';
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    private ra: string | null = null;
    open() {}
    setRequestHeader() {}
    getResponseHeader(h: string) { return h.toLowerCase() === 'retry-after' ? this.ra : null; }
    send(body: string) {
      sent.push({
        body: JSON.parse(body),
        respond: (status, retryAfter) => {
          this.status = status; this.ra = retryAfter ?? null;
          if (status === 0) this.onerror?.(); else this.onload?.();
        },
      });
    }
  }
  const noop = () => {};
  const el = () => ({ addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null });
  const document = {
    currentScript: null, readyState: 'complete', title: 't', referrer: '', cookie: '',
    addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], body: el(), documentElement: { lang: 'en' },
    createElement: el, getElementsByTagName: () => [],
  };
  const windowProps: Record<string, unknown> = {
    location: { href: 'https://example.com/p', pathname: '/p', search: '', hostname: 'example.com' },
    innerWidth: 1, innerHeight: 1, screen: { width: 1, height: 1 }, addEventListener: noop,
  };
  const DateFake = class extends Date { static override now() { return now; } };
  // In a browser `window` is the global object (the script uses bare EcommTracker).
  const sandbox: Record<string, unknown> = {
    ...windowProps, document, navigator: { userAgent: 'test', language: 'en' }, XMLHttpRequest: FakeXHR,
    setInterval: (fn: () => void) => { tick = fn; return 1; }, setTimeout: () => 1, clearTimeout: noop, clearInterval: noop,
    console, Date: DateFake, Math, JSON, Intl, Promise, Set, Object, Array, String, Number, parseInt, parseFloat,
    IntersectionObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SRC, sandbox);
  const window = sandbox;
  const T = window.EcommTracker as {
    init(c: object): void; track(n: string, d?: object): void; setConfig(c: object): void;
    _delivery: { retryable(s: number): boolean; delayMs(f: number, ra: unknown, c: object, r: number): number; capQueue<T>(q: T[], m: number): T[] };
  };
  T.init({ endpoint: '/c', siteId: 'pk_x', automaticEvents: false, autoTrackProductViews: false, autoTrackAddToCart: false, autoTrackCheckout: false, autoTrackPurchase: false });
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    T, sent,
    advance: (ms: number) => { now += ms; },
    tick: async () => { tick?.(); await flush(); },
    flush,
  };
}

test('delivery policy: retryable statuses, capped exponential backoff, queue cap', () => {
  const { T } = load();
  const d = T._delivery;
  for (const s of [0, 408, 429, 500, 502, 503]) assert.equal(d.retryable(s), true, String(s));
  for (const s of [400, 401, 403, 404, 413]) assert.equal(d.retryable(s), false, String(s));
  const cfg = { retryBaseMs: 2000, retryMaxMs: 300000 };
  assert.deepEqual([1, 2, 3, 4].map((n) => d.delayMs(n, null, cfg, 1)), [2000, 4000, 8000, 16000]);
  assert.equal(d.delayMs(20, null, cfg, 1), 300000); // capped at 5 min
  assert.equal(d.delayMs(1, null, cfg, 0), 1000); // jitter floor = 50%
  assert.equal(d.delayMs(1, '30', cfg, 1), 30000); // Retry-After honoured
  assert.equal(d.delayMs(1, '99999', cfg, 1), 300000); // …up to the cap
  assert.deepEqual(d.capQueue([1, 2, 3, 4], 2), [3, 4]);
});

test('a failed batch backs off instead of resending every tick', async () => {
  const { T, sent, tick, advance, flush } = load();
  await tick();
  assert.equal(sent.length, 1); // initial pageview
  sent[0]!.respond(503);
  await flush();
  for (let i = 0; i < 10; i++) { advance(100); await tick(); } // 1 s later: still backing off
  assert.equal(sent.length, 1);
  advance(5000);
  await tick();
  assert.equal(sent.length, 2); // retried after the backoff…
  assert.equal(sent[1]!.body.events[0]!.name, 'pageview'); // …with the same batch
  sent[1]!.respond(200);
  await flush();
  T.track('next');
  await tick();
  assert.equal(sent.length, 3); // healthy again: no delay
  assert.equal(sent[2]!.body.events[0]!.name, 'next');
});

test('no second request while one is in flight', async () => {
  const { T, sent, tick } = load();
  await tick();
  T.track('a');
  await tick();
  await tick();
  assert.equal(sent.length, 1);
});

test('401/403 drop the batch; repeated rejections stop the tracker', async () => {
  const { T, sent, tick, advance, flush } = load();
  await tick();
  sent[0]!.respond(401);
  await flush();
  advance(10_000);
  T.track('b');
  await tick();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.body.events.map((e) => e.name), ['b']); // pageview was dropped, not resent
  sent[1]!.respond(403);
  await flush();
  advance(60_000);
  T.track('c');
  await tick();
  sent[2]!.respond(403);
  await flush();
  // Three consecutive permanent rejections → paused for this page view.
  advance(600_000);
  T.track('d');
  await tick();
  await tick();
  assert.equal(sent.length, 3);
});

test('queue is capped while the collector is unreachable (oldest dropped)', async () => {
  const { T, sent, tick, advance, flush } = load();
  T.setConfig({ maxQueue: 20 });
  await tick();
  sent[0]!.respond(0); // network error: retryable, pageview stays queued
  await flush();
  for (let i = 0; i < 100; i++) T.track('e' + i);
  T.track('last');
  advance(10_000);
  await tick();
  assert.equal(sent.length, 2);
  // 102 events offered, 20 kept: e81…e99 + last. First batch = 10 oldest survivors.
  assert.deepEqual(sent[1]!.body.events.map((e) => e.name), ['e81', 'e82', 'e83', 'e84', 'e85', 'e86', 'e87', 'e88', 'e89', 'e90']);
  sent[1]!.respond(200);
  await flush();
  await tick();
  assert.deepEqual(sent[2]!.body.events.map((e) => e.name), ['e91', 'e92', 'e93', 'e94', 'e95', 'e96', 'e97', 'e98', 'e99', 'last']);
});
