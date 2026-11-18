'use client';
/**
 * Sticky report filters.
 *
 * - The filter state lives in the URL query string (router.push), so Back /
 *   Forward and shared links restore exactly what was on screen.
 * - The last filters used on each report are kept in localStorage and put
 *   back (router.replace — no extra history entry) when the report is opened
 *   with no filter params, e.g. from the sidebar or a detail page's back link.
 * - "Reset" clears both, so a reset is remembered too.
 *
 * The form is keyed on the current query string: when Back/Forward changes
 * the URL, the inputs re-mount with that URL's values instead of keeping
 * stale ones.
 */
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export type FilterField =
  | { name: string; label: string; type: 'select'; options: Array<{ value: string; label: string }>; defaultValue?: string }
  | { name: string; label: string; type: 'date'; defaultValue?: string };

const storeKey = (report: string) => `mp:filters:${report}`;

export function filterQuery(fields: FilterField[], values: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const f of fields) {
    const v = (values[f.name] ?? '').trim();
    if (v) q.set(f.name, v);
  }
  return q.toString();
}

export default function FilterBar({ report, fields, summary }: { report: string; fields: FilterField[]; summary?: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const qs = sp.toString();
  const [restoring, setRestoring] = useState(false);
  const restored = useRef(false);

  const hasFilterParams = fields.some((f) => sp.has(f.name));

  // Persist whatever filters the URL holds (also covers Back/Forward + shared links).
  useEffect(() => {
    if (!hasFilterParams) return;
    try {
      const vals: Record<string, string> = {};
      for (const f of fields) {
        const v = sp.get(f.name);
        if (v != null) vals[f.name] = v;
      }
      localStorage.setItem(storeKey(report), JSON.stringify(vals));
    } catch { /* storage blocked */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs, report]);

  // Opened without filter params → restore the last-used filters once.
  useEffect(() => {
    if (restored.current || hasFilterParams) return;
    restored.current = true;
    try {
      const raw = localStorage.getItem(storeKey(report));
      if (!raw) return;
      const vals = JSON.parse(raw) as Record<string, string>;
      const q = filterQuery(fields, vals);
      if (q) {
        setRestoring(true);
        router.replace(`${pathname}?${q}`, { scroll: false });
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setRestoring(false), [qs]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const vals: Record<string, string> = {};
    for (const f of fields) vals[f.name] = String(fd.get(f.name) ?? '');
    const q = filterQuery(fields, vals);
    try { localStorage.setItem(storeKey(report), JSON.stringify(vals)); } catch { /* ignore */ }
    router.push(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }

  function onReset() {
    try { localStorage.removeItem(storeKey(report)); } catch { /* ignore */ }
    router.push(pathname, { scroll: false });
  }

  return (
    <form key={qs} onSubmit={onSubmit} className="grid grid-cols-2 items-end gap-3 text-sm sm:flex sm:flex-wrap" data-report={report}>
      {fields.map((f) => {
        const current = sp.get(f.name) ?? f.defaultValue ?? '';
        return (
          <label key={f.name} className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-muted-foreground">{f.label}</span>
            {f.type === 'select' ? (
              <select name={f.name} defaultValue={current} className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 sm:w-auto sm:max-w-[220px]">
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input type="date" name={f.name} defaultValue={current} className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 sm:w-auto" />
            )}
          </label>
        );
      })}
      <div className="col-span-2 flex items-center gap-3 sm:col-span-1">
        <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">Apply</button>
        <button type="button" onClick={onReset} className="pb-0.5 text-xs text-muted-foreground underline">reset</button>
        {restoring && <span className="text-xs text-muted-foreground">restoring your last filters…</span>}
      </div>
      {summary && <div className="col-span-2 text-xs text-muted-foreground sm:ml-auto sm:pb-1.5">{summary}</div>}
    </form>
  );
}
