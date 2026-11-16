/**
 * Recipe 121 — "Performance Marketing: True ROAS and Customer LTV" — expressed
 * as executable SQL, so the app can seed the warehouse and run every analysis
 * step live against SynapCores. This is the recipe, made "full circle": the
 * markdown recipe becomes a running application.
 *
 * Source: docs/bulkRecipes/recipes/121_performance_marketing_roas_ltv.md
 */

// ── Step 1: schema (the marketing warehouse) ────────────────────────────────
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS recipe_pm_ad_spend (
     row_id INTEGER PRIMARY KEY, platform TEXT, campaign_id TEXT, campaign_name TEXT,
     objective TEXT, day TIMESTAMP, spend DOUBLE, impressions INTEGER, clicks_reported INTEGER)`,
  `CREATE TABLE IF NOT EXISTS recipe_pm_creative (
     creative_id INTEGER PRIMARY KEY, campaign_id TEXT, headline TEXT, body_copy TEXT, angle VECTOR(384))`,
  `CREATE TABLE IF NOT EXISTS recipe_pm_click_events (
     event_id INTEGER PRIMARY KEY, anonymous_id TEXT, occurred_at TIMESTAMP, landing_path TEXT,
     utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, click_id TEXT, device TEXT, site TEXT)`,
  `CREATE TABLE IF NOT EXISTS recipe_pm_identity (
     anonymous_id TEXT PRIMARY KEY, customer_id INTEGER, identified_at TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS recipe_pm_conversions (
     conversion_id INTEGER PRIMARY KEY, anonymous_id TEXT, occurred_at TIMESTAMP, event_name TEXT, revenue DOUBLE, site TEXT)`,
  `CREATE TABLE IF NOT EXISTS recipe_pm_orders (
     order_id INTEGER PRIMARY KEY, customer_id INTEGER, ordered_at TIMESTAMP, revenue DOUBLE, gross_margin DOUBLE)`,
  `CREATE TABLE IF NOT EXISTS recipe_pm_attribution (
     conversion_id INTEGER PRIMARY KEY, anonymous_id TEXT, customer_id INTEGER, campaign_id TEXT,
     platform TEXT, first_order_revenue DOUBLE, converted_at TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS recipe_pm_campaign_scorecard (
     campaign_id TEXT PRIMARY KEY, campaign_name TEXT, platform TEXT, spend DOUBLE, new_customers INTEGER,
     cac DOUBLE, day0_roas DOUBLE, ltv_90d DOUBLE, ltv_roas DOUBLE, margin_roas DOUBLE)`,
];

export const TABLES = [
  'recipe_pm_ad_spend', 'recipe_pm_creative', 'recipe_pm_click_events', 'recipe_pm_identity',
  'recipe_pm_conversions', 'recipe_pm_orders', 'recipe_pm_attribution', 'recipe_pm_campaign_scorecard',
];

// ── Steps 2–4: seed data (verbatim from the recipe) ─────────────────────────
export const SEED = [
  `INSERT INTO recipe_pm_ad_spend (row_id, platform, campaign_id, campaign_name, objective, day, spend, impressions, clicks_reported) VALUES
   (1,'facebook','fb-1001','FB_Prospecting_Broad_US','prospecting','2026-05-04',420.00,58200,6),
   (2,'facebook','fb-1001','FB_Prospecting_Broad_US','prospecting','2026-05-05',400.00,55400,5),
   (3,'facebook','fb-1001','FB_Prospecting_Broad_US','prospecting','2026-05-06',380.00,52100,4),
   (4,'facebook','fb-1002','FB_Retargeting_DPA','retargeting','2026-05-04',110.00,9400,2),
   (5,'facebook','fb-1002','FB_Retargeting_DPA','retargeting','2026-05-05',95.00,8100,2),
   (6,'facebook','fb-1002','FB_Retargeting_DPA','retargeting','2026-05-06',95.00,8300,2),
   (7,'tiktok','tt-2001','TT_Creator_UGC_Q2','prospecting','2026-05-04',280.00,141000,8),
   (8,'tiktok','tt-2001','TT_Creator_UGC_Q2','prospecting','2026-05-05',260.00,133500,7),
   (9,'tiktok','tt-2001','TT_Creator_UGC_Q2','prospecting','2026-05-06',260.00,129800,6),
   (10,'google','gg-3001','GG_Brand_Exact','brand','2026-05-04',140.00,2100,2),
   (11,'google','gg-3001','GG_Brand_Exact','brand','2026-05-05',130.00,1950,2),
   (12,'google','gg-3001','GG_Brand_Exact','brand','2026-05-06',130.00,2000,2),
   (13,'google','gg-3002','GG_NonBrand_Generic','prospecting','2026-05-04',340.00,18600,3),
   (14,'google','gg-3002','GG_NonBrand_Generic','prospecting','2026-05-05',330.00,17900,3),
   (15,'google','gg-3002','GG_NonBrand_Generic','prospecting','2026-05-06',330.00,18200,3)`,

  `INSERT INTO recipe_pm_click_events (event_id, anonymous_id, occurred_at, landing_path, utm_source, utm_medium, utm_campaign, click_id, device) VALUES
   (1,'a_f01','2026-05-04 10:12:00','/lp/summer-bundle','facebook','paid_social','fb-1001','fbclid_8Kq2','mobile'),
   (2,'a_x01','2026-05-04 11:40:00','/lp/summer-bundle','facebook','paid_social','fb-1001','fbclid_9Lm4','mobile'),
   (3,'a_x02','2026-05-04 15:05:00','/lp/summer-bundle','facebook','paid_social','fb-1001','fbclid_2Rt7','desktop'),
   (4,'a_x03','2026-05-04 18:22:00','/lp/summer-bundle','facebook','paid_social','fb-1001','fbclid_5Yh1','mobile'),
   (5,'a_x04','2026-05-05 08:30:00','/lp/summer-bundle','facebook','paid_social','fb-1001','fbclid_1Qa5','desktop'),
   (6,'a_f02','2026-05-05 14:03:00','/lp/summer-bundle','facebook','paid_social','fb-1001','fbclid_3Wp9','mobile'),
   (7,'a_f01','2026-05-05 19:48:00','/products/tote','facebook','paid_social','fb-1001','fbclid_7Nz3','mobile'),
   (8,'a_x05','2026-05-05 21:11:00','/lp/summer-bundle','facebook','paid_social','fb-1001','fbclid_6Bd8','mobile'),
   (9,'a_f03','2026-05-06 09:41:00','/lp/summer-bundle','facebook','paid_social','fb-1001','fbclid_4Cf2','mobile'),
   (10,'a_x06','2026-05-06 12:55:00','/lp/summer-bundle','facebook','paid_social','fb-1001','fbclid_8Gh6','mobile'),
   (11,'a_x07','2026-05-06 17:30:00','/lp/summer-bundle','facebook','paid_social','fb-1001','fbclid_0Jk9','desktop'),
   (12,'a_x08','2026-05-06 20:02:00','/lp/summer-bundle','facebook','paid_social','fb-1001','fbclid_2Ml4','mobile'),
   (13,'a_x09','2026-05-04 16:14:00','/products/tote','facebook','paid_social','fb-1002','fbclid_3Vb2','mobile'),
   (14,'a_f04','2026-05-05 11:00:00','/products/tote','facebook','paid_social','fb-1002','fbclid_5Pn7','mobile'),
   (15,'a_x10','2026-05-05 13:37:00','/cart','facebook','paid_social','fb-1002','fbclid_9Xz1','desktop'),
   (16,'a_f05','2026-05-06 16:20:00','/products/tote','facebook','paid_social','fb-1002','fbclid_1Dq8','mobile'),
   (17,'a_x11','2026-05-06 19:05:00','/cart','facebook','paid_social','fb-1002','fbclid_7Sw3','mobile'),
   (18,'a_g04','2026-05-04 18:00:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_A1b2','mobile'),
   (19,'a_t01','2026-05-04 19:30:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_C3d4','mobile'),
   (20,'a_x12','2026-05-04 20:15:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_E5f6','mobile'),
   (21,'a_x13','2026-05-04 21:02:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_G7h8','mobile'),
   (22,'a_x14','2026-05-04 22:40:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_I9j0','mobile'),
   (23,'a_x15','2026-05-05 18:33:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_K1l2','mobile'),
   (24,'a_x16','2026-05-05 19:55:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_M3n4','mobile'),
   (25,'a_t02','2026-05-05 20:15:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_O5p6','mobile'),
   (26,'a_x17','2026-05-05 21:47:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_Q7r8','mobile'),
   (27,'a_x18','2026-05-05 23:10:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_S9t0','mobile'),
   (28,'a_x19','2026-05-06 18:20:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_U1v2','mobile'),
   (29,'a_x20','2026-05-06 19:41:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_W3x4','mobile'),
   (30,'a_x21','2026-05-06 20:58:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_Y5z6','mobile'),
   (31,'a_x22','2026-05-06 22:14:00','/lp/creator-pick','tiktok','paid_social','tt-2001','ttclid_A7b8','mobile'),
   (32,'a_g01','2026-05-04 08:30:00','/','google','cpc','gg-3001','gclid_Ee11','desktop'),
   (33,'a_x23','2026-05-04 13:12:00','/','google','cpc','gg-3001','gclid_Ff22','mobile'),
   (34,'a_g02','2026-05-05 12:45:00','/','google','cpc','gg-3001','gclid_Gg33','desktop'),
   (35,'a_x24','2026-05-05 15:28:00','/','google','cpc','gg-3001','gclid_Hh44','mobile'),
   (36,'a_x25','2026-05-06 10:44:00','/','google','cpc','gg-3001','gclid_Ii55','desktop'),
   (37,'a_g03','2026-05-06 15:10:00','/','google','cpc','gg-3001','gclid_Jj66','desktop'),
   (38,'a_x26','2026-05-04 09:20:00','/lp/compare','google','cpc','gg-3002','gclid_Kk77','desktop'),
   (39,'a_x27','2026-05-04 14:50:00','/lp/compare','google','cpc','gg-3002','gclid_Ll88','mobile'),
   (40,'a_x28','2026-05-05 09:05:00','/lp/compare','google','cpc','gg-3002','gclid_Mm99','desktop'),
   (41,'a_x29','2026-05-05 16:37:00','/lp/compare','google','cpc','gg-3002','gclid_Nn10','mobile'),
   (42,'a_g04','2026-05-06 10:05:00','/lp/compare','google','cpc','gg-3002','gclid_Oo11','desktop'),
   (43,'a_g05','2026-05-06 13:22:00','/lp/compare','google','cpc','gg-3002','gclid_Pp12','desktop'),
   (44,'a_x30','2026-05-06 17:55:00','/lp/compare','google','cpc','gg-3002','gclid_Qq13','mobile'),
   (45,'a_x31','2026-05-06 21:30:00','/lp/compare','google','cpc','gg-3002','gclid_Rr14','desktop'),
   (46,'a_f01','2026-05-20 12:00:00','/products/tote','facebook','paid_social','fb-1002','fbclid_LATE1','mobile')`,

  `INSERT INTO recipe_pm_identity (anonymous_id, customer_id, identified_at) VALUES
   ('a_f01',501,'2026-05-08 09:00:00'),('a_f02',502,'2026-05-08 11:30:00'),
   ('a_f03',503,'2026-05-09 10:15:00'),('a_f04',504,'2026-05-07 12:00:00'),
   ('a_f05',505,'2026-05-08 17:45:00'),('a_t01',506,'2026-05-06 21:00:00'),
   ('a_t02',507,'2026-05-07 19:20:00'),('a_g01',508,'2026-05-05 09:10:00'),
   ('a_g02',509,'2026-05-06 13:00:00'),('a_g03',510,'2026-05-07 16:00:00'),
   ('a_g04',511,'2026-05-07 11:20:00'),('a_g05',512,'2026-05-08 14:50:00')`,

  `INSERT INTO recipe_pm_conversions (conversion_id, anonymous_id, occurred_at, event_name, revenue) VALUES
   (1,'a_f01','2026-05-08 09:00:00','first_purchase',95.00),
   (2,'a_f02','2026-05-08 11:30:00','first_purchase',95.00),
   (3,'a_f03','2026-05-09 10:15:00','first_purchase',95.00),
   (4,'a_f04','2026-05-07 12:00:00','first_purchase',110.00),
   (5,'a_f05','2026-05-08 17:45:00','first_purchase',110.00),
   (6,'a_t01','2026-05-06 21:00:00','first_purchase',42.00),
   (7,'a_t02','2026-05-07 19:20:00','first_purchase',42.00),
   (8,'a_g01','2026-05-05 09:10:00','first_purchase',130.00),
   (9,'a_g02','2026-05-06 13:00:00','first_purchase',130.00),
   (10,'a_g03','2026-05-07 16:00:00','first_purchase',130.00),
   (11,'a_g04','2026-05-07 11:20:00','first_purchase',145.00),
   (12,'a_g05','2026-05-08 14:50:00','first_purchase',145.00)`,

  `INSERT INTO recipe_pm_orders (order_id, customer_id, ordered_at, revenue, gross_margin) VALUES
   (1,501,'2026-05-08 09:00:00',95.00,57.00),(2,501,'2026-06-05 14:20:00',225.00,135.00),
   (3,501,'2026-07-11 10:05:00',200.00,120.00),(4,502,'2026-05-08 11:30:00',95.00,57.00),
   (5,502,'2026-06-12 16:40:00',225.00,135.00),(6,502,'2026-07-18 09:15:00',200.00,120.00),
   (7,503,'2026-05-09 10:15:00',95.00,57.00),(8,503,'2026-06-14 11:50:00',225.00,135.00),
   (9,503,'2026-07-21 15:30:00',200.00,120.00),(10,504,'2026-05-07 12:00:00',110.00,66.00),
   (11,504,'2026-06-20 13:25:00',220.00,132.00),(12,505,'2026-05-08 17:45:00',110.00,66.00),
   (13,505,'2026-06-25 18:10:00',220.00,132.00),(14,506,'2026-05-06 21:00:00',42.00,25.20),
   (15,506,'2026-05-29 20:35:00',18.00,10.80),(16,507,'2026-05-07 19:20:00',42.00,25.20),
   (17,507,'2026-06-02 19:45:00',18.00,10.80),(18,508,'2026-05-05 09:10:00',130.00,78.00),
   (19,508,'2026-06-08 10:30:00',210.00,126.00),(20,509,'2026-05-06 13:00:00',130.00,78.00),
   (21,509,'2026-06-16 14:05:00',210.00,126.00),(22,510,'2026-05-07 16:00:00',130.00,78.00),
   (23,510,'2026-06-22 12:40:00',210.00,126.00),(24,511,'2026-05-07 11:20:00',145.00,87.00),
   (25,511,'2026-06-10 09:55:00',620.00,372.00),(26,511,'2026-07-15 11:10:00',685.00,411.00),
   (27,512,'2026-05-08 14:50:00',145.00,87.00),(28,512,'2026-06-18 15:35:00',620.00,372.00),
   (29,512,'2026-07-24 16:20:00',685.00,411.00)`,

  `INSERT INTO recipe_pm_creative (creative_id, campaign_id, headline, body_copy) VALUES
   (1,'fb-1001','Built for the long haul','Our summer bundle is made from full-grain leather and organic canvas. Designed to last for years, not seasons. Sixty day free returns and a lifetime repair warranty.'),
   (2,'fb-1002','Still thinking about the Tote?','The bag you were looking at is still in stock. Ships free today and we cover the return if it is not right for you.'),
   (3,'tt-2001','70% OFF TODAY ONLY','Everyone is grabbing these before the flash sale ends at midnight. Cheapest price of the year. Hurry, limited stock, link in bio.'),
   (4,'gg-3001','The official store','Shop the official collection direct from us. Authentic products, full manufacturer warranty, free shipping on every order.'),
   (5,'gg-3002','Compare the best everyday tote bags','An honest side by side comparison of materials, capacity, and warranty across the top everyday totes, with sizing guidance to help you choose.')`,

  // Step 5: embed the creative angle (all-minilm, 384-dim)
  `UPDATE recipe_pm_creative SET angle = EMBED(headline || ' ' || body_copy)`,
];

// ── Step 7: last-touch attribution (30-day lookback, click <= convert) ──────
// NOTE: written with inline derived tables, not CTEs — on SynapCores 2.x,
// joins between CTEs drop the ON predicate (cross product). Derived-table
// joins behave correctly.
//
// Only purchase conversions make a "new customer": lead / signup rows (written
// by the pixel collector, see NON_PURCHASE_CONVERSIONS in collector.ts) are
// conversions for reporting but must not inflate new_customers / CAC / ROAS.
//
// SynapCores CE applies a window subquery's WHERE after projection, so the
// join + lookback filter runs in its own (window-free) derived table `touches`
// and the window ranks that; filtering e.occurred_at in the same SELECT as the
// ROW_NUMBER fails with "Column 'e.occurred_at' not found".
export const ATTRIBUTION = `
  INSERT INTO recipe_pm_attribution (conversion_id, anonymous_id, customer_id, campaign_id, platform, first_order_revenue, converted_at)
  SELECT w.conversion_id, w.anonymous_id, i.customer_id, w.campaign_id, w.source, w.revenue, w.convert_at
  FROM (
    SELECT conversion_id, anonymous_id, revenue, campaign_id, source, convert_at
    FROM (
      SELECT conversion_id, anonymous_id, revenue, campaign_id, source, convert_at, event_name,
             ROW_NUMBER() OVER (PARTITION BY conversion_id ORDER BY click_at DESC) AS rn
      FROM (
        SELECT v.conversion_id AS conversion_id, v.anonymous_id AS anonymous_id, v.revenue AS revenue,
               e.utm_campaign AS campaign_id, e.utm_source AS source,
               e.occurred_at AS click_at, v.occurred_at AS convert_at, v.event_name AS event_name
        FROM recipe_pm_conversions v
        JOIN recipe_pm_click_events e ON e.anonymous_id = v.anonymous_id
        WHERE e.occurred_at <= v.occurred_at
          AND (julianday(v.occurred_at) - julianday(e.occurred_at)) <= 30
      ) touches
    ) ranked
    WHERE rn = 1 AND COALESCE(event_name, 'first_purchase') NOT IN ('lead', 'signup')
  ) w
  JOIN recipe_pm_identity i ON i.anonymous_id = w.anonymous_id`;

// ── Step 10: build the 90-day scorecard (the ROAS flip lives here) ──────────
export const SCORECARD = `
  INSERT INTO recipe_pm_campaign_scorecard (campaign_id, campaign_name, platform, spend, new_customers, cac, day0_roas, ltv_90d, ltv_roas, margin_roas)
  SELECT s.campaign_id, s.campaign_name, s.platform, s.spend, c.new_customers,
         ROUND(COALESCE(s.spend / NULLIF(c.new_customers, 0), 0), 2),
         ROUND(COALESCE(c.day0_revenue / NULLIF(s.spend, 0), 0), 3),
         ROUND(COALESCE(l.ltv_revenue / NULLIF(c.new_customers, 0), 0), 2),
         ROUND(COALESCE(l.ltv_revenue / NULLIF(s.spend, 0), 0), 2),
         ROUND(COALESCE(l.ltv_margin / NULLIF(s.spend, 0), 0), 2)
  FROM (
    SELECT campaign_id, platform, campaign_name, COALESCE(SUM(spend), 0) AS spend
    FROM recipe_pm_ad_spend GROUP BY campaign_id, platform, campaign_name
  ) s
  JOIN (
    SELECT campaign_id, COUNT(*) AS new_customers, COALESCE(SUM(first_order_revenue), 0) AS day0_revenue
    FROM recipe_pm_attribution GROUP BY campaign_id
  ) c ON c.campaign_id = s.campaign_id
  JOIN (
    SELECT a.campaign_id AS campaign_id, COALESCE(SUM(o.revenue), 0) AS ltv_revenue, COALESCE(SUM(o.gross_margin), 0) AS ltv_margin
    FROM recipe_pm_attribution a
    JOIN recipe_pm_orders o ON o.customer_id = a.customer_id
    WHERE (julianday(o.ordered_at) - julianday(a.converted_at)) <= 90
    GROUP BY a.campaign_id
  ) l ON l.campaign_id = s.campaign_id`;

// ── Analysis queries (read side) ────────────────────────────────────────────
export const QUERIES = {
  // Step 6: platform-reported vs site-observed clicks → true CPC
  clickTruth: `
    SELECT p.campaign_id, p.spend, p.clicks_reported, s.clicks_observed,
           ROUND(COALESCE(p.spend / NULLIF(s.clicks_observed, 0), 0), 2) AS true_cpc,
           ROUND(COALESCE((p.clicks_reported - s.clicks_observed) * 100.0 / NULLIF(s.clicks_observed, 0), 0), 1) AS inflation_pct
    FROM (
      SELECT campaign_id, COALESCE(SUM(spend), 0) AS spend, COALESCE(SUM(impressions), 0) AS impressions, COALESCE(SUM(clicks_reported), 0) AS clicks_reported
      FROM recipe_pm_ad_spend GROUP BY campaign_id
    ) p
    JOIN (
      SELECT utm_campaign AS campaign_id, COUNT(*) AS clicks_observed
      FROM recipe_pm_click_events
      WHERE occurred_at < '2026-05-07 00:00:00'
      GROUP BY utm_campaign
    ) s ON s.campaign_id = p.campaign_id
    ORDER BY p.spend DESC`,

  scorecard: `
    SELECT campaign_id, campaign_name, platform, spend, new_customers, cac, day0_roas, ltv_90d, ltv_roas, margin_roas
    FROM recipe_pm_campaign_scorecard
    ORDER BY ltv_roas DESC`,

  // Step 11: creative discount-affinity vs LTV
  creativeAngle: `
    SELECT s.campaign_name, s.campaign_id, g.discount_affinity,
           ROUND(COALESCE(l.ltv_revenue / NULLIF(c.new_customers, 0), 0), 2) AS ltv_90d,
           ROUND(COALESCE(l.ltv_revenue / NULLIF(s.spend, 0), 0), 2) AS ltv_roas,
           cr.headline
    FROM (
      SELECT campaign_id, campaign_name, COALESCE(SUM(spend), 0) AS spend
      FROM recipe_pm_ad_spend GROUP BY campaign_id, campaign_name
    ) s
    JOIN (
      SELECT campaign_id,
             ROUND(COALESCE(COSINE_SIMILARITY(angle, EMBED('limited time flash sale discount hurry cheapest price')), 0), 4) AS discount_affinity
      FROM recipe_pm_creative
    ) g ON g.campaign_id = s.campaign_id
    JOIN (
      SELECT campaign_id, COUNT(*) AS new_customers
      FROM recipe_pm_attribution GROUP BY campaign_id
    ) c ON c.campaign_id = s.campaign_id
    JOIN (
      SELECT a.campaign_id AS campaign_id, COALESCE(SUM(o.revenue), 0) AS ltv_revenue
      FROM recipe_pm_attribution a JOIN recipe_pm_orders o ON o.customer_id = a.customer_id GROUP BY a.campaign_id
    ) l ON l.campaign_id = s.campaign_id
    JOIN recipe_pm_creative cr ON cr.campaign_id = s.campaign_id
    ORDER BY g.discount_affinity DESC`,

  // Step 8: the attribution ledger (with the two proof rows)
  attribution: `
    SELECT a.conversion_id, a.anonymous_id, a.customer_id, a.campaign_id, sc.campaign_name, a.platform, a.first_order_revenue, a.converted_at
    FROM recipe_pm_attribution a
    LEFT JOIN recipe_pm_campaign_scorecard sc ON sc.campaign_id = a.campaign_id
    ORDER BY a.conversion_id`,

  kpis: `
    SELECT
      (SELECT ROUND(COALESCE(SUM(spend), 0), 2) FROM recipe_pm_ad_spend) AS total_spend,
      (SELECT COUNT(*) FROM recipe_pm_attribution) AS new_customers,
      (SELECT COUNT(*) FROM recipe_pm_campaign_scorecard) AS campaigns`,
};

// Step 12: the "full circle" — the database recommends the budget decision.
export const AGENT_TASK =
  'You are a performance marketing analyst. Use execute_query to read every row of the table ' +
  'recipe_pm_campaign_scorecard. Columns: campaign_name, platform, spend, new_customers, cac, day0_roas, ' +
  'ltv_90d, ltv_roas, margin_roas. Then recommend how to reallocate next month budget. Name the one ' +
  'campaign to cut and the one campaign to scale, and justify each using the ltv_roas and margin_roas ' +
  'values you read. Under 150 words.';

