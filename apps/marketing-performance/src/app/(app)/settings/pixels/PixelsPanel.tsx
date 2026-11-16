'use client';
import { useState, useTransition } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
} from '@synapcores/app-framework';
import {
  createPixelAction,
  disablePixelAction,
  deletePixelAction,
} from '@/lib/pixel-actions';
import { LocalTime } from '@/components/LocalTime';

interface Pixel {
  id: string;
  label: string;
  allowed_origins: string | null;
  created_at: string;
  disabled_at: string | null;
  last_used_at: string | null;
}

function snippet(origin: string, pixelId: string): string {
  return `<script
  src="${origin}/track.js"
  data-endpoint="${origin}/api/v1/collect"
  data-site-id="${pixelId}"
  defer></script>`;
}

export function PixelsPanel({ pixels, origin }: { pixels: Pixel[]; origin: string }) {
  const [busy, startTransition] = useTransition();
  const [label, setLabel] = useState('');
  const [origins, setOrigins] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  function create() {
    setMsg(null);
    startTransition(async () => {
      const r = await createPixelAction({ label, allowedOrigins: origins });
      if (!r.ok) setMsg({ kind: 'err', text: r.error });
      else {
        setMsg({ kind: 'ok', text: `Pixel “${r.pixel.label}” created.` });
        setLabel('');
        setOrigins('');
      }
    });
  }

  function disable(id: string) {
    startTransition(async () => {
      const r = await disablePixelAction(id);
      if (!r.ok) setMsg({ kind: 'err', text: r.error });
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const r = await deletePixelAction(id);
      if (!r.ok) setMsg({ kind: 'err', text: r.error });
    });
  }

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500);
    } catch {
      /* clipboard blocked; the value is selectable in the page */
    }
  }

  return (
    <div className="space-y-6">
      {msg && (
        <div
          className={
            'rounded-md border px-4 py-2 text-sm ' +
            (msg.kind === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-500')
          }
        >
          {msg.text}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Create a pixel</CardTitle>
          <CardDescription>
            Give it a label (usually the site it goes on). Optionally restrict it to
            specific origins — the domain-verification equivalent; leave blank to accept
            events from anywhere.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Label</span>
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder="shop.yourco.com"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Allowed origins (optional, one per line)</span>
              <textarea
                className="h-[42px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder="https://shop.yourco.com"
                value={origins}
                onChange={(e) => setOrigins(e.target.value)}
              />
            </label>
          </div>
          <Button disabled={busy || !label.trim()} onClick={create}>
            {busy ? 'Working…' : 'Create pixel'}
          </Button>
        </CardContent>
      </Card>

      {pixels.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pixels yet. Create one above.</p>
      ) : (
        <div className="space-y-4">
          {pixels.map((p) => {
            const code = snippet(origin, p.id);
            const off = Boolean(p.disabled_at);
            return (
              <Card key={p.id} className={off ? 'opacity-60' : ''}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    {p.label}
                    {off && (
                      <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                        disabled
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {p.allowed_origins
                      ? `restricted to: ${p.allowed_origins}`
                      : 'accepts events from any origin'}
                    {p.last_used_at ? <> · last event <LocalTime value={p.last_used_at} /></> : ' · no events yet'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 text-xs">{p.id}</code>
                    <Button variant="outline" size="sm" onClick={() => copy(p.id, `id:${p.id}`)}>
                      {copied === `id:${p.id}` ? 'Copied' : 'Copy id'}
                    </Button>
                  </div>
                  <div className="relative">
                    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed"><code>{code}</code></pre>
                    <Button
                      variant="outline"
                      size="sm"
                      className="absolute right-2 top-2"
                      onClick={() => copy(code, `snip:${p.id}`)}
                    >
                      {copied === `snip:${p.id}` ? 'Copied' : 'Copy snippet'}
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    {!off && (
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => disable(p.id)}>
                        Disable
                      </Button>
                    )}
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(p.id)}>
                      Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Server-to-server events</CardTitle>
          <CardDescription>
            Sending purchases from your backend (the Conversions-API equivalent) uses a{' '}
            <strong>secret</strong> key, not a pixel id. Mint one under{' '}
            <a className="underline" href="/settings/api-keys">Settings › API Keys</a> and send it as{' '}
            <code>Authorization: Bearer sk_user_…</code> — never put it in a browser.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
