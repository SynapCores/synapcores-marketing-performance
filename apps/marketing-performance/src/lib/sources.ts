/**
 * Ingestion sources — the mapping from a named data source (what an ETL job or
 * a CSV upload targets) to a warehouse table and its column order. Shared by
 * the UI upload and the REST ingestion API so both stay in lockstep.
 */
export interface SourceDef {
  id: string;
  label: string;
  table: string;
  columns: string[];      // canonical column order
  keyColumn: string;      // primary key column (used to auto-number if absent)
  /** columns the caller may omit; we fill them (e.g. platform for FB/TT/GG). */
  fixed?: Record<string, string | number>;
  sample?: string;        // example row for docs
}

export const SOURCES: Record<string, SourceDef> = {
  facebook: {
    id: 'facebook', label: 'Facebook Ads — spend', table: 'recipe_pm_ad_spend',
    columns: ['row_id', 'platform', 'campaign_id', 'campaign_name', 'objective', 'day', 'spend', 'impressions', 'clicks_reported'],
    keyColumn: 'row_id', fixed: { platform: 'facebook' },
    sample: '{"campaign_id":"fb-1001","campaign_name":"FB_Prospecting","objective":"prospecting","day":"2026-05-04","spend":420,"impressions":58200,"clicks_reported":6}',
  },
  tiktok: {
    id: 'tiktok', label: 'TikTok Ads — spend', table: 'recipe_pm_ad_spend',
    columns: ['row_id', 'platform', 'campaign_id', 'campaign_name', 'objective', 'day', 'spend', 'impressions', 'clicks_reported'],
    keyColumn: 'row_id', fixed: { platform: 'tiktok' },
    sample: '{"campaign_id":"tt-2001","campaign_name":"TT_Creator_UGC","objective":"prospecting","day":"2026-05-04","spend":280,"impressions":141000,"clicks_reported":8}',
  },
  google: {
    id: 'google', label: 'Google Ads — spend', table: 'recipe_pm_ad_spend',
    columns: ['row_id', 'platform', 'campaign_id', 'campaign_name', 'objective', 'day', 'spend', 'impressions', 'clicks_reported'],
    keyColumn: 'row_id', fixed: { platform: 'google' },
    sample: '{"campaign_id":"gg-3002","campaign_name":"GG_NonBrand","objective":"prospecting","day":"2026-05-04","spend":340,"impressions":18600,"clicks_reported":3}',
  },
  clickstream: {
    id: 'clickstream', label: 'Web analytics — clickstream', table: 'recipe_pm_click_events',
    columns: ['event_id', 'anonymous_id', 'occurred_at', 'landing_path', 'utm_source', 'utm_medium', 'utm_campaign', 'click_id', 'device'],
    keyColumn: 'event_id',
    sample: '{"anonymous_id":"a_f01","occurred_at":"2026-05-04 10:12:00","landing_path":"/lp/summer","utm_source":"facebook","utm_medium":"paid_social","utm_campaign":"fb-1001","click_id":"fbclid_8Kq2","device":"mobile"}',
  },
  identity: {
    id: 'identity', label: 'Identity resolution', table: 'recipe_pm_identity',
    columns: ['anonymous_id', 'customer_id', 'identified_at'], keyColumn: 'anonymous_id',
    sample: '{"anonymous_id":"a_f01","customer_id":501,"identified_at":"2026-05-08 09:00:00"}',
  },
  conversions: {
    id: 'conversions', label: 'Conversions', table: 'recipe_pm_conversions',
    columns: ['conversion_id', 'anonymous_id', 'occurred_at', 'event_name', 'revenue'], keyColumn: 'conversion_id',
    sample: '{"anonymous_id":"a_f01","occurred_at":"2026-05-08 09:00:00","event_name":"first_purchase","revenue":95}',
  },
  orders: {
    id: 'orders', label: 'Order history', table: 'recipe_pm_orders',
    columns: ['order_id', 'customer_id', 'ordered_at', 'revenue', 'gross_margin'], keyColumn: 'order_id',
    sample: '{"customer_id":501,"ordered_at":"2026-06-05 14:20:00","revenue":225,"gross_margin":135}',
  },
  creative: {
    id: 'creative', label: 'Ad creative', table: 'recipe_pm_creative',
    columns: ['creative_id', 'campaign_id', 'headline', 'body_copy'], keyColumn: 'creative_id',
    sample: '{"campaign_id":"fb-1001","headline":"Built for the long haul","body_copy":"Full-grain leather..."}',
  },
};

export const SOURCE_LIST = Object.values(SOURCES);

/** Turn an array of source-shaped objects into ordered column rows for ingestRows. */
export function mapRows(def: SourceDef, records: Array<Record<string, unknown>>, startId: number): unknown[][] {
  let auto = startId;
  return records.map((rec) => {
    const merged = { ...(def.fixed ?? {}), ...rec };
    if (merged[def.keyColumn] === undefined || merged[def.keyColumn] === null || merged[def.keyColumn] === '') {
      merged[def.keyColumn] = auto++;
    }
    return def.columns.map((c) => merged[c] ?? null);
  });
}
