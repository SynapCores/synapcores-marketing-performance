import Link from 'next/link';

export type SortDir = 'asc' | 'desc';

/** Read ?sort=&dir= against an allow-list; falls back to the report default. */
export function parseSort<K extends string>(sort: unknown, dir: unknown, allowed: readonly K[], fallback: K): { sort: K; dir: SortDir } {
  const s = (allowed as readonly string[]).includes(String(sort)) ? (String(sort) as K) : fallback;
  const d: SortDir = dir === 'asc' ? 'asc' : dir === 'desc' ? 'desc' : 'desc';
  return { sort: s, dir: d };
}

/** Compare for sorting; null/empty values always go last. */
export function cmp(a: string | number | null | undefined, b: string | number | null | undefined, dir: SortDir): number {
  const ea = a == null || a === '';
  const eb = b == null || b === '';
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const r = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
  return dir === 'asc' ? r : -r;
}

/**
 * Clickable column header: keeps the current filters in the URL, sets
 * ?sort=<col>; clicking the active column flips the direction.
 */
export function SortHeader({
  label, col, query, sort, dir, align = 'left', title, className = '',
}: {
  label: string;
  col: string;
  /** Current query string (filters), without sort/dir. */
  query: string;
  sort: string;
  dir: SortDir;
  align?: 'left' | 'right';
  title?: string;
  className?: string;
}) {
  const active = sort === col;
  const next: SortDir = active ? (dir === 'desc' ? 'asc' : 'desc') : 'desc';
  const q = new URLSearchParams(query);
  q.set('sort', col);
  q.set('dir', next);
  return (
    <th className={`${align === 'right' ? 'text-right' : ''} ${className}`} title={title} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <Link href={`?${q}`} scroll={false} className={`inline-flex items-center gap-1 hover:text-foreground ${active ? 'text-foreground' : ''}`}>
        {label}
        <span aria-hidden className={active ? '' : 'opacity-30'}>{active && dir === 'asc' ? '▲' : '▼'}</span>
      </Link>
    </th>
  );
}
