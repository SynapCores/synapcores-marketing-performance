'use server';
import { revalidatePath } from 'next/cache';
import { requireSession } from './session';
import { assertCanWrite } from './security';
import { loadSampleData, rebuildDerived, ingestRows, clearAll, recommend } from './warehouse';

export async function recommendAction() {
  await requireSession();
  return recommend();
}
import { SOURCES, mapRows } from './sources';
import { getAdminClient } from '@synapcores/app-framework/db/server';

export async function loadSampleAction() {
  assertCanWrite(await requireSession());
  await loadSampleData();
  revalidatePath('/dashboard'); revalidatePath('/tables'); revalidatePath('/campaigns');
  return { ok: true };
}

export async function rebuildAction() {
  assertCanWrite(await requireSession());
  await rebuildDerived();
  revalidatePath('/dashboard'); revalidatePath('/attribution'); revalidatePath('/campaigns');
  return { ok: true };
}

export async function clearAction() {
  assertCanWrite(await requireSession());
  await clearAll();
  revalidatePath('/dashboard'); revalidatePath('/tables');
  return { ok: true };
}

/** Parse a CSV string (header row → keys) into source records and ingest them. */
export async function ingestCsvAction(source: string, csv: string) {
  assertCanWrite(await requireSession());
  if (typeof csv !== 'string' || csv.length > 5_000_000) return { ok: false, error: 'CSV too large (5 MB max per upload).' };
  const def = SOURCES[source];
  if (!def) return { ok: false, error: `Unknown source '${source}'` };
  const rows = parseCsv(csv);
  if (!rows.length) return { ok: false, error: 'No data rows found in the CSV.' };

  const db = getAdminClient();
  let startId = 1;
  try {
    const max = await db.sqlScalar<number>(`SELECT COALESCE(MAX(${def.keyColumn}), 0) FROM ${def.table}`);
    if (typeof max === 'number') startId = max + 1;
  } catch { /* ignore */ }

  const mapped = mapRows(def, rows, startId);
  const n = await ingestRows(def.table, def.columns, mapped);
  try { await rebuildDerived(); } catch { /* ignore */ }
  revalidatePath('/dashboard'); revalidatePath('/tables');
  return { ok: true, ingested: n, table: def.table };
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0] ?? '');
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const rec: Record<string, string> = {};
    header.forEach((h, i) => { rec[h.trim()] = (cells[i] ?? '').trim(); });
    return rec;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  }
  out.push(cur);
  return out;
}
