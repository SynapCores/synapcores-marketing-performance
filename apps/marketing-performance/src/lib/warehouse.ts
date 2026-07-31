import 'server-only';
import { getAdminClient } from '@synapcores/app-framework/db/server';
import { SCHEMA, TABLES, SEED, ATTRIBUTION, SCORECARD, QUERIES, AGENT_TASK } from './recipe-sql';

/**
 * The performance-marketing warehouse — recipe 121 as a first-class data layer.
 * Platform ad spend, first-party clickstream, identity, conversions, orders and
 * the ad creative (as 384-dim embeddings) all live in SynapCores. Attribution
 * and the 90-day LTV scorecard are derived with live SQL.
 */

const db = () => getAdminClient();
async function run(sql: string) { await db().sql(sql); }

/** Human-facing metadata for each warehouse table (for the Tables explorer + ingest). */
export const TABLE_META: Record<string, { label: string; group: string; desc: string; source: string }> = {
  recipe_pm_ad_spend:          { label: 'Ad Spend',        group: 'Platform',    desc: 'Daily spend / impressions / reported clicks per campaign', source: 'Facebook · TikTok · Google Ads' },
  recipe_pm_creative:          { label: 'Creative',        group: 'Platform',    desc: 'Ad headline + body copy, embedded as a 384-dim angle vector', source: 'Ad accounts' },
  recipe_pm_click_events:      { label: 'Click Events',    group: 'First-party', desc: 'Your own landing hits with UTMs + click IDs (fbclid/ttclid/gclid)', source: 'Web analytics' },
  recipe_pm_identity:          { label: 'Identity',        group: 'First-party', desc: 'Anonymous browser → known customer resolution', source: 'CDP / identity graph' },
  recipe_pm_conversions:       { label: 'Conversions',     group: 'First-party', desc: 'First-purchase events with revenue', source: 'Checkout' },
  recipe_pm_orders:            { label: 'Orders',          group: 'First-party', desc: 'Full order history incl. the repeats ad platforms never see', source: 'Orders DB' },
  recipe_pm_attribution:       { label: 'Attribution',     group: 'Derived',     desc: 'Last-touch attribution ledger (computed)', source: 'Derived · Step 7' },
  recipe_pm_campaign_scorecard:{ label: 'Campaign Scorecard', group: 'Derived',  desc: 'Day-0 + 90-day LTV scorecard (computed)', source: 'Derived · Step 10' },
};

// ── lifecycle ───────────────────────────────────────────────────────────────
export async function ensureSchema() { for (const ddl of SCHEMA) await run(ddl); }

export async function clearAll() {
  for (const t of TABLES) { try { await run(`DROP TABLE IF EXISTS ${t}`); } catch { /* ignore */ } }
}

/** Recompute attribution + scorecard from the base tables (Steps 7 & 10). */
export async function rebuildDerived() {
  await run(`DROP TABLE IF EXISTS recipe_pm_attribution`);
  await run(`DROP TABLE IF EXISTS recipe_pm_campaign_scorecard`);
  await ensureSchema();
  await run(ATTRIBUTION);
  await run(SCORECARD);
}

/** One-click: wipe, recreate, seed the recipe-121 sample dataset, rebuild derived. */
export async function loadSampleData() {
  await clearAll();
  await ensureSchema();
  for (const stmt of SEED) await run(stmt);
  await run(ATTRIBUTION);
  await run(SCORECARD);
}

// ── ingestion ────────────────────────────────────────────────────────────────
/** Insert parsed rows (array of objects) into a warehouse table. Chunked. */
export async function ingestRows(table: string, columns: string[], rows: unknown[][]) {
  if (!rows.length) return 0;
  await ensureSchema();
  const chunk = 200;
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const values = slice.map((r) => '(' + r.map((v) => sqlLit(v)).join(',') + ')').join(',');
    await run(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values}`);
    n += slice.length;
  }
  // creative embeddings are populated on ingest
  if (table === 'recipe_pm_creative') {
    await run(`UPDATE recipe_pm_creative SET angle = EMBED(headline || ' ' || body_copy) WHERE angle IS NULL`);
  }
  return n;
}

function sqlLit(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ── reads ────────────────────────────────────────────────────────────────────
export type Row = Record<string, unknown>;

type TableMetaEntry = (typeof TABLE_META)[string] | undefined;
export async function listTables(): Promise<Array<{ table: string; count: number; meta: TableMetaEntry }>> {
  const out: Array<{ table: string; count: number; meta: TableMetaEntry }> = [];
  for (const t of TABLES) {
    let count = 0;
    try { count = Number((await db().sqlScalar<number>(`SELECT COUNT(*) FROM ${t}`)) ?? 0); }
    catch { count = -1; } // table not created yet
    out.push({ table: t, count, meta: TABLE_META[t] });
  }
  return out;
}

export async function tableRows(table: string, limit = 200): Promise<{ columns: string[]; rows: Row[] }> {
  if (!TABLES.includes(table)) throw new Error('unknown table');
  const res = await db().sql<Row>(`SELECT * FROM ${table} LIMIT ${limit}`);
  return { columns: res.columns, rows: res.rows };
}

export async function kpis() {
  const k = (await db().sql<Row>(QUERIES.kpis)).rows[0] ?? {};
  const sc = (await db().sql<Row>(QUERIES.scorecard)).rows;
  const platforms = new Set(sc.map((r) => r.platform)).size;
  const total = Number(k.total_spend ?? 0), cust = Number(k.new_customers ?? 0);
  return {
    total_spend: total,
    new_customers: cust,
    campaigns: Number(k.campaigns ?? 0),
    platforms,
    blended_cac: cust ? Math.round((total / cust) * 100) / 100 : null,
  };
}

export const scorecard = async () => (await db().sql<Row>(QUERIES.scorecard)).rows;
export const clickTruth = async () => (await db().sql<Row>(QUERIES.clickTruth)).rows;
export const creativeAngle = async () => (await db().sql<Row>(QUERIES.creativeAngle)).rows;
export const attribution = async () => (await db().sql<Row>(QUERIES.attribution)).rows;

/** Step 12 — AGENT_RUN budget recommendation, with a deterministic fallback. */
export async function recommend(): Promise<{ source: 'agent_run' | 'fallback'; text: string; tookMs: number; reason?: string }> {
  const started = Date.now();
  try {
    const out = await db().sqlScalar<string>(
      `SELECT AGENT_RUN('aidb-assistant', $1, json_object('max_iterations', 2, 'timeout_ms', 75000)) AS rec`,
      [AGENT_TASK],
    );
    const text = String(out ?? '').trim();
    const failed = !text || /^AGENT_RUN error|exceeded its .* budget|failed in ReAct|no AI service/i.test(text);
    if (!failed) return { source: 'agent_run', text, tookMs: Date.now() - started };
    throw new Error(text || 'AGENT_RUN unavailable');
  } catch (e) {
    const sc = await scorecard().catch(() => [] as Row[]);
    const byLtv = [...sc].sort((a, b) => Number(b.ltv_roas) - Number(a.ltv_roas));
    const cut = [...sc].sort((a, b) => Number(a.margin_roas) - Number(b.margin_roas))[0];
    const scale = byLtv[0];
    const text = scale && cut
      ? `Cut **${cut.campaign_name}** (${cut.platform}): it returns only $${cut.margin_roas} of gross margin per $1 spent (margin ROAS ${cut.margin_roas}, LTV ROAS ${cut.ltv_roas}) — a contribution loss. Scale **${scale.campaign_name}** (${scale.platform}): highest 90-day LTV:CAC at ${scale.ltv_roas}× (margin ROAS ${scale.margin_roas}), 90-day LTV $${scale.ltv_90d} against a $${scale.cac} CAC — even though it was only mid-pack on day-0 ROAS. The day-0 number was optimizing to the platform's incentive, not yours.`
      : 'Load the sample dataset (or ingest your ad data) to generate a recommendation.';
    return { source: 'fallback', text, tookMs: Date.now() - started, reason: String((e as Error).message) };
  }
}
