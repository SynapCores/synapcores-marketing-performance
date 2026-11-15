# Visitor capture (`pm_events`)

The collector (`POST /api/v1/collect`) stores **every** event the pixel sends in
`pm_events`, one row per event, enriched on the server. The recipe tables
(`recipe_pm_click_events`, `recipe_pm_conversions`, `recipe_pm_identity`) are
still fed exactly as before, so attribution is unchanged.

| Group | Columns |
|---|---|
| Identity | `event_id` (server UUID), `tenant_id`, `pixel_id`, `source_kind` (pixel / key / dev), `anonymous_id` (first-party cookie), `session_id` |
| Time | `occurred_at` (client clock, clamped to −7 d…+5 min of receipt), `received_at` |
| Event | `event_type` (pageview, navigation_click, scroll, view_item, add_to_cart, purchase, form_submit, …), `properties` (event data as JSON, e-mail addresses redacted, ≤ 4 KB) |
| Page | `page_url`, `page_path`, `page_title`, `site` (host) |
| Acquisition | `referrer`, `referrer_domain`, `utm_source/medium/campaign/term/content`, `gclid`, `fbclid`, `ttclid`, `msclkid` |
| Client | `user_agent`, `browser`, `browser_version`, `os`, `os_version`, `device_type`, `language`, `timezone`, `screen_w/h`, `viewport_w/h` |
| Bot | `is_bot`, `bot_name`, `bot_category` (`ai`, `search`, `social`, `seo`, `monitor`, `headless`, `tool`, `other`) |
| Network | `ip`, `ip_prefix` (/24 or /48), `ip_truncated` |
| Geo | `country` (ISO-2), `country_name`, `region`, `city`, `latitude`/`longitude` (rounded to 0.1°) |

## Where each value comes from

- **IP**: the `X-Forwarded-For` entry appended by our Apache proxy
  (`TRUSTED_PROXY_HOPS`, default 1, counted from the right). Entries further
  left are client-supplied and ignored. On the server-to-server path (`sk_`
  key) the body's `ip` field is used instead, because the request comes from
  the customer's server.
- **Geo**: a local DB-IP City Lite `.mmdb` (`GEOIP_DB_PATH`), read on demand by
  `src/lib/visitor/mmdb.ts` (positional reads + page cache, so the 130 MB file
  is never loaded into memory). No external API is called. Refresh monthly
  with `bin/update-geoip.sh`. Attribution: "IP geolocation by DB-IP" (CC BY 4.0),
  shown in the app footer.
- **UA / bots**: `src/lib/visitor/ua.ts`. It recognises AI crawlers and agents
  (GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, Claude-User, PerplexityBot,
  CCBot, Bytespider, Google-Extended, Meta-ExternalAgent, Amazonbot, Applebot-Extended,
  …), search engines, social link unfurlers, SEO tools, monitors, headless
  browsers and scripted HTTP clients. Most training crawlers don't run
  JavaScript, so a pixel mainly sees AI *agents/browsers* and headless fetchers.
  Catching every crawler would need server access logs.
- **Timezone / language / screen**: sent by `track.js`. The `Accept-Language`
  header is the fallback for language.

## Retention and privacy

- Full IP for `IP_RETENTION_DAYS` (default 90). After that the sweep in
  `src/instrumentation.ts` (at boot + every `IP_RETENTION_SWEEP_HOURS`, default 6)
  sets `ip = ip_prefix, ip_truncated = TRUE`. Geo derived at collection time is kept.
- DNT / GPC: batches with `DNT: 1` or `Sec-GPC: 1` from the hosts in
  `COLLECT_PRIVACY_SIGNAL_HOSTS` (default renascai.com) are dropped server-side.
  The renascai snippet also skips loading the pixel for those visitors.

## UI

- **Visitors** (`/visitors`): one row per visitor (first/last seen, location + IP,
  device/browser/OS, first-touch source, site + landing page, pages, events,
  human/bot/AI-bot badge). Filters: humans/bots, site, country, date range.
- **Visitor detail** (`/visitors/<anonymous_id>`): profile + the full event
  timeline grouped by session.
- **Dashboard**: a "Visitors — last 30 days" card with the human/bot split,
  top countries and bots by name.

All reads are scoped to the signed-in workspace (`tenant_id`).
