-- @synapcores/marketing-performance — domain schema (the marketing warehouse)
-- Recipe 121: platform spend + first-party clickstream + identity + orders +
-- ad creative (embeddings). Attribution & scorecard are DERIVED, rebuilt by the app.
CREATE TABLE IF NOT EXISTS recipe_pm_ad_spend (
  row_id INTEGER PRIMARY KEY, platform TEXT, campaign_id TEXT, campaign_name TEXT,
  objective TEXT, day TIMESTAMP, spend DOUBLE, impressions INTEGER, clicks_reported INTEGER);
CREATE TABLE IF NOT EXISTS recipe_pm_creative (
  creative_id INTEGER PRIMARY KEY, campaign_id TEXT, headline TEXT, body_copy TEXT, angle VECTOR(384));
CREATE TABLE IF NOT EXISTS recipe_pm_click_events (
  event_id INTEGER PRIMARY KEY, anonymous_id TEXT, occurred_at TIMESTAMP, landing_path TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, click_id TEXT, device TEXT, site TEXT);
CREATE TABLE IF NOT EXISTS recipe_pm_identity (
  anonymous_id TEXT PRIMARY KEY, customer_id INTEGER, identified_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS recipe_pm_conversions (
  conversion_id INTEGER PRIMARY KEY, anonymous_id TEXT, occurred_at TIMESTAMP, event_name TEXT, revenue DOUBLE, site TEXT);
CREATE TABLE IF NOT EXISTS recipe_pm_orders (
  order_id INTEGER PRIMARY KEY, customer_id INTEGER, ordered_at TIMESTAMP, revenue DOUBLE, gross_margin DOUBLE);
CREATE TABLE IF NOT EXISTS recipe_pm_attribution (
  conversion_id INTEGER PRIMARY KEY, anonymous_id TEXT, customer_id INTEGER, campaign_id TEXT,
  platform TEXT, first_order_revenue DOUBLE, converted_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS recipe_pm_campaign_scorecard (
  campaign_id TEXT PRIMARY KEY, campaign_name TEXT, platform TEXT, spend DOUBLE, new_customers INTEGER,
  cac DOUBLE, day0_roas DOUBLE, ltv_90d DOUBLE, ltv_roas DOUBLE, margin_roas DOUBLE);
