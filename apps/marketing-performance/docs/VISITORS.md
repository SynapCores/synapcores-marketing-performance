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
| Bot | `is_bot`, `bot_name`, `bot_category` (`ai`, `search`, `social`, `seo`, `monitor`, `headless`, `tool`, `other`), `bot_verified` (`verified` / `unverified` / `unverifiable`), `bot_rules_version` |
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
  JavaScript, so a pixel mainly sees AI *agents/browsers*, headless fetchers and
  Google's renderer.
- **Crawler IP verification**: `src/lib/visitor/classify.ts` combines the UA
  verdict with the client IP and the operators' published crawler ranges
  (`crawler-sources.json`: Google googlebot / special-crawlers / user-triggered
  fetchers, Bing, OpenAI GPTBot / OAI-SearchBot / ChatGPT-User, Anthropic,
  Perplexity, Apple, DuckDuckGo, Common Crawl).
  - UA claims a crawler and the IP is in that operator's ranges: `verified`.
  - UA claims it but the IP isn't: `unverified` ("claims Googlebot,
    unverified"; spoofed or a new range). Still a bot.
  - Bots with no published list (Yandex, Ahrefs, curl, ...): `unverifiable`.
  - A normal browser UA from a crawler range (Google renders pages with a
    plain Chrome UA from 66.249.x): bot, `verified`, named after the range.
  The lists come from a bundled snapshot (`crawler-ranges.bundled.json`,
  regenerate with `node bin/update-crawler-ranges.mjs`), are cached in
  `CRAWLER_RANGES_CACHE` (default `/var/lib/mktperf-app/crawler-ranges.json`)
  and refreshed every `CRAWLER_RANGES_REFRESH_HOURS` (24). A failed fetch keeps
  the previous list. When the rules change, bump `CLASSIFIER_VERSION`: stored
  events with an older `bot_rules_version` are reclassified at boot.
- A visitor with **any** bot event counts as a bot (Visitors filter and the
  dashboard split).
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

## Visitor types: human, internal, suspected bot, bot

Every report that says "humans" (Visitors, dashboard card, funnel, UTM Campaigns)
uses one classification, `src/lib/visitor/kinds.ts`, computed at read time over
all of the workspace's visitors (cached 30 s). Precedence: internal > bot > suspected > human.

| Type | Rule |
|---|---|
| internal | any event from an IP in `VISITOR_INTERNAL_IPS` |
| bot | declared / verified crawler (UA + published ranges, `classify.ts`) |
| suspected | a **burst**: ≥ `VISITOR_BURST_MIN` (5) single-pageview, no-interaction visitors first seen within `VISITOR_BURST_WINDOW_S` (60) s on the same site, from the same utm_source / referrer, with the same browser, OS, device and screen size; or a **data-centre network**: hosting ASN (DB-IP ASN Lite, `asn.ts`) or `VISITOR_DATACENTER_IPS` |
| human | everyone else |

Nothing is deleted: the Type filter shows each group. Config (app env):

```
VISITOR_INTERNAL_IPS="136.57.16.0/24 office, 100.51.180.101 agentNet server, 98.121.244.0/24 Pineville NC"
VISITOR_DATACENTER_IPS="203.0.113.0/24 some-host"     # optional, on top of the ASN list
VISITOR_BURST_MIN=5
VISITOR_BURST_WINDOW_S=60
GEOIP_ASN_DB_PATH=/opt/mktperf/geoip/dbip-asn-lite.mmdb   # default: next to GEOIP_DB_PATH
```

Entries are `cidr[ label]`, separated by commas or new lines; the label is shown as the reason.
`bin/update-geoip.sh` refreshes both DB-IP files monthly.

## UTM campaigns

- The pixel keeps the landing URL's `utm_*` / click ids in `sessionStorage` for the tab's
  session and sends them with every later event, so a sign-up on a later page still carries
  the campaign. An SPA that rewrites its address before `track.js` loads can hand over the
  original landing URL: `window.EcommTrackerLanding = { url, path }` (same origin only).
- **UTM Campaigns** (`/utm-campaigns`): visitors, sessions, pageviews, leads, sign-ups and
  purchases per (site, utm_source, utm_medium, utm_campaign). Saved campaigns with no traffic
  show as "no traffic yet"; campaigns in the data that were never saved show as "untracked".
- **Campaign Links** (`/utm-campaigns/builder`): builds the tagged URL and saves the campaign
  (`pm_campaigns`: name, channel, notes, created date, tagged URL).

Filters on these reports live in the URL (Back/Forward restore them) and the last-used
filters per report are kept in `localStorage` (`mp:filters:<report>`) and restored when the
report is opened without parameters.
