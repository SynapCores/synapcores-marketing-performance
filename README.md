# SynapCores — Performance Marketing

A full-stack **performance-marketing application** built on the
[SynapCores](https://synapcores.com) AI-native database. It answers the one
question every growth team fights over — *which campaigns actually make money?* —
by computing **true ROAS against 90-day LTV**, not the day-0 number the ad
platforms report.

Everything runs in **one engine**: platform ad spend, first-party clickstream,
identity resolution, conversions, orders, and the ad creative (stored as 384-dim
embeddings) — fed by a **first-party tracking pixel you host yourself**, so the
clickstream is your own data on your own domains, not a third party's. Last-touch attribution and the LTV scorecard are derived with live
SQL; the budget recommendation is an in-database agent (`AGENT_RUN`). No vector
DB, no separate attribution pipeline, no notebook.

Built on `@synapcores/app-framework` (the same auth / RBAC / UI / agent / tenant
/ audit primitives behind the SOAR and AML reference apps).

```
                  ┌──────────────────────────────┐
                  │    SynapCores Engine (CE)    │
                  │  vectors · SQL · graph · AI  │
                  │           :28080             │
                  └──────────────┬───────────────┘
                                 │  EMBED · COSINE_SIMILARITY · AGENT_RUN
                        ┌────────▼─────────┐
                        │  Marketing app   │
                        │      :3005       │
                        └──────────────────┘
                         @synapcores/app-framework
                    (auth · RBAC · UI · agent · tenants · audit)
```

## What it does

| Surface | What you see | The SynapCores primitive underneath |
|---|---|---|
| **The ROAS Flip** | Day-0 ROAS ranking vs. 90-day LTV:CAC ranking, joined by connecting lines — the order reverses | Two live SQL rankings over the scorecard |
| **Campaign Scorecard** | Spend, CAC, day-0 ROAS, 90-day LTV, LTV ROAS, margin ROAS per campaign | CTE over spend + attribution + orders |
| **The Click Truth** | Platform-reported clicks vs. what your site actually recorded (the CPC-corrupting gap) | First-party clickstream join |
| **The Creative Angle** | Each ad's copy scored against a discount/urgency vector vs. the LTV it bought — an inverse trend | `EMBED` + `COSINE_SIMILARITY` on the creative |
| **Attribution Ledger** | Last-touch credit across all platforms, with the cross-platform steal corrected | `ROW_NUMBER` over the clickstream |
| **First-party pixel** | A drop-in `<script>` you host; it streams page views, identifies and purchases from your own sites straight into the warehouse, tagged by domain | `public/track.js` → `POST /api/v1/collect` |
| **Ask the Database** | An agent reads the scorecard with its own SQL tool and recommends the budget move | `AGENT_RUN` (deterministic fallback when no LLM) |

Plus a full **Ingest** page (load the sample dataset, or upload per-source CSVs
for Facebook / TikTok / Google / clickstream / identity / conversions / orders /
creative), a **Data Tables** explorer over the whole warehouse, and an
**ETL ingestion REST API** (`POST /api/v1/ingest/:source`, API-key auth) so you
can wire a pipeline that pushes data straight in.

## Quickstart (docker compose)

Requires Docker 24+ and ~4 GB free RAM for the engine.

```sh
git clone https://github.com/SynapCores/synapcores-marketing-performance
cd synapcores-marketing-performance
cp .env.example .env
# 1. generate the two secrets the .env asks for:
#    openssl rand -base64 32   → AIDB_JWT_SECRET and AUTH_SECRET
docker compose up -d synapcores
# 2. grab the engine's first-boot admin password:
docker compose logs synapcores | grep "password:"
# 3. log into the engine UI at http://localhost:28080, mint an admin API
#    token, and paste it into .env as SYNAPCORES_ADMIN_API_KEY
docker compose up -d app
```

Then open **http://localhost:3005/register**, create an account, and on the
**Ingest** page click *Load sample data* to seed the recipe-121 dataset and see
the full analysis.

## Local development

```sh
pnpm install
cp apps/marketing-performance/.env.example apps/marketing-performance/.env.local
# point SYNAPCORES_URL at your engine + set a real SYNAPCORES_ADMIN_API_KEY
pnpm bootstrap        # framework + app schema
pnpm dev              # → http://localhost:3005
```

## Track your own sites — the first-party pixel

The clickstream the analysis runs on is **your own first-party data**, collected
by a pixel you host and drop onto the sites you own. No third-party analytics,
no shared cookie, no data leaving your stack. One deployment of this app can
track several of your domains at once.

**1. Mint a site write-key.** In the app, go to **Settings → API keys** and
create a key (label it e.g. `pixel`). Copy the `sk_user_…` value — it is shown
once. This key authorizes writes to the collector and nothing the pixel does can
exceed it.

**2. Drop the snippet on each domain you want to track.** Point `src` and
`data-endpoint` at wherever *this app* is deployed; `data-site-id` is the key
from step 1. The same snippet goes on every one of your domains:

```html
<!-- on shop.yourco.com, blog.yourco.com, yourco.io, … -->
<script
  src="https://metrics.yourco.com/track.js"
  data-endpoint="https://metrics.yourco.com/api/v1/collect"
  data-site-id="sk_user_XXXXXXXXXXXX"
  defer></script>
```

A **page view fires automatically** on load (capturing the landing path, UTMs
and click IDs — `fbclid` / `gclid` / `ttclid` / `msclkid`). Fire the two events
that matter for attribution yourself:

```js
// when a visitor becomes a known customer
EcommTracker.track('identify', { customer_id: 501 });

// on a completed purchase
EcommTracker.track('purchase', { revenue: 95 });
```

**3. Tracking several domains.** Every row the collector writes is stamped with
the **domain it came from** (the `site` column on `recipe_pm_click_events` and
`recipe_pm_conversions`), so three or four domains sharing one key stay cleanly
separable — filter by `site` in the **Data Tables** explorer or any query.
(Want each domain fully isolated as its own workspace instead of one tagged
pool? Mint a separate key per domain; per-tenant data isolation is the next step
on the roadmap.)

**4. Verify it's flowing.** Open a tracked page (e.g. with
`?utm_source=facebook&utm_campaign=fb-1001&fbclid=demo`), then in the app open
**Data Tables → Click Events** — you'll see the hit, with your domain in `site`.
A ready-made local test page lives at `/collect-demo.html`.

**How it works.** `public/track.js` batches events and POSTs them to
`POST /api/v1/collect`. The route authenticates the key, maps the batch into the
warehouse's clickstream / identity / conversion tables, and refreshes attribution
— all in the one SynapCores engine. It is a clean-room, dependency-free collector
(a Next.js route handler, a built-in rate limiter, `crypto`/`Date` instead of
`uuid`): **nothing beyond the app's own stack is pulled in.**

> **Security note.** The `data-site-id` key is embedded in your public pages, so
> treat it as exposed: mint a **dedicated** key just for the pixel (never your
> admin key) so you can rotate it on its own. A dedicated public, write-only
> key type (`pk_…`) that is safe to embed by design is the next hardening step;
> until then the write-key is an ordinary app key scoped to its tenant.

## The data & logic

The warehouse and every metric come from the published
[`121_performance_marketing_roas_ltv`](https://synapcores.com/recipes/) recipe —
the numbers here reproduce it exactly (blended CAC $308.33, the ROAS flip, the
inverse creative-angle correlation, the two attribution proof rows).

## License

Apache-2.0. SynapCores™, AIDB™ and SQLv2™ are trademarks of Luis Mata.
