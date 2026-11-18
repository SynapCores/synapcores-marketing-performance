'use client';
import { useMemo, useState, useTransition } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@synapcores/app-framework';
import { createCampaignAction, deleteCampaignAction } from '@/lib/campaign-actions';
import { buildCampaignUrl, CHANNELS } from '@/lib/visitor/campaign-links';
import type { SavedCampaign } from '@/lib/visitor/campaigns';
import CopyButton from '@/components/CopyButton';

const input = 'w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm';

const SUGGEST: Record<string, { source: string; medium: string }> = {
  youtube: { source: 'youtube', medium: 'video' },
  reddit: { source: 'reddit', medium: 'social' },
  email: { source: 'newsletter', medium: 'email' },
  social: { source: 'linkedin', medium: 'social' },
  'paid search': { source: 'google', medium: 'cpc' },
  'paid social': { source: 'facebook', medium: 'paid_social' },
  'referral / partner': { source: 'partner', medium: 'referral' },
  community: { source: 'discord', medium: 'community' },
  other: { source: '', medium: '' },
};

export default function BuilderPanel({ campaigns, sites, canEdit }: { campaigns: SavedCampaign[]; sites: string[]; canEdit: boolean }) {
  const [busy, start] = useTransition();
  const [f, setF] = useState({ siteUrl: sites[0] ? `https://${sites[0]}/` : 'https://', channel: 'youtube', source: 'youtube', medium: 'video', campaign: '', content: '', term: '', name: '', notes: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [saved, setSaved] = useState<SavedCampaign | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const preview = useMemo(() => buildCampaignUrl(f), [f]);

  function onChannel(e: React.ChangeEvent<HTMLSelectElement>) {
    const ch = e.target.value;
    const s = SUGGEST[ch] ?? SUGGEST.other!;
    setF({ ...f, channel: ch, source: s.source || f.source, medium: s.medium || f.medium });
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    start(async () => {
      const r = await createCampaignAction(f);
      if (!r.ok) {
        setMsg({ kind: 'err', text: r.error });
        return;
      }
      setSaved(r.campaign);
      setMsg({ kind: 'ok', text: `Campaign “${r.campaign.name}” saved.` });
    });
  }

  function remove(id: string, name: string) {
    if (!window.confirm(`Delete the campaign “${name}”? Its visits stay in the data and will show as untracked.`)) return;
    start(async () => {
      const r = await deleteCampaignAction(id);
      if (!r.ok) setMsg({ kind: 'err', text: r.error });
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>New campaign link</CardTitle>
          <CardDescription>Use lowercase and dashes so the same campaign isn&apos;t split by spelling (youtube ≠ YouTube).</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">Page URL (where the link should land)</span>
              <input name="siteUrl" className={input} value={f.siteUrl} onChange={set('siteUrl')} list="known-sites" placeholder="https://werkor.us/" required />
              <datalist id="known-sites">{sites.map((s) => <option key={s} value={`https://${s}/`} />)}</datalist>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Channel</span>
              <select name="channel" className={input} value={f.channel} onChange={onChannel}>
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Campaign name (for you)</span>
              <input name="name" className={input} value={f.name} onChange={set('name')} placeholder="Werkor tutorials, November" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">utm_source *</span>
              <input name="source" className={input} value={f.source} onChange={set('source')} placeholder="youtube" required />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">utm_medium *</span>
              <input name="medium" className={input} value={f.medium} onChange={set('medium')} placeholder="video" required />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">utm_campaign *</span>
              <input name="campaign" className={input} value={f.campaign} onChange={set('campaign')} placeholder="tutorials" required />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">utm_content (optional — which video / post / ad)</span>
              <input name="content" className={input} value={f.content} onChange={set('content')} placeholder="05-estimates-invoices" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">utm_term (optional — keyword)</span>
              <input name="term" className={input} value={f.term} onChange={set('term')} />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">Notes</span>
              <textarea name="notes" rows={2} className={input} value={f.notes} onChange={set('notes')} placeholder="Where this link is used" />
            </label>
            <div className="sm:col-span-2">
              <div className="text-xs text-muted-foreground">Tagged URL</div>
              <div className="mt-1 break-all rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs" data-testid="tagged-url">
                {preview.ok ? preview.url : <span className="text-muted-foreground">{preview.error}</span>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {preview.ok && <CopyButton text={preview.url} label="Copy URL" />}
                <button type="submit" disabled={busy || !canEdit || !preview.ok} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50">
                  {busy ? 'Saving…' : 'Save campaign'}
                </button>
                {!canEdit && <span className="text-xs text-muted-foreground">Only owners/admins can save campaigns.</span>}
                {msg && <span className={'text-xs ' + (msg.kind === 'ok' ? 'text-emerald-500' : 'text-rose-500')} role="status">{msg.text}</span>}
              </div>
              {saved && (
                <div className="mt-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2 text-xs">
                  Saved link: <span className="break-all font-mono">{saved.tagged_url}</span> <CopyButton text={saved.tagged_url} />
                </div>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Saved campaigns</CardTitle><CardDescription>{campaigns.length} campaign{campaigns.length === 1 ? '' : 's'}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {campaigns.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
          {campaigns.map((c) => (
            <div key={c.campaign_id} className="rounded-md border border-border p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="font-medium">{c.name} <span className="text-xs font-normal text-muted-foreground">· {c.channel ?? 'other'} · {c.site} · created {c.created_at.slice(0, 10)}</span></div>
                <div className="flex gap-2">
                  <CopyButton text={c.tagged_url} label="Copy link" />
                  {canEdit && <button type="button" onClick={() => remove(c.campaign_id, c.name)} className="rounded border border-border px-2 py-0.5 text-xs text-rose-500 hover:bg-muted">Delete</button>}
                </div>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{[c.utm_source, c.utm_medium, c.utm_campaign, c.utm_content].filter(Boolean).join(' / ')}</div>
              <div className="mt-1 break-all font-mono text-[11px]">{c.tagged_url}</div>
              {c.notes && <div className="mt-1 text-xs">{c.notes}</div>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
