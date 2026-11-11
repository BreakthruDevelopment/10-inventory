# Inventory Management

> Small shops and warehouses keep stock counts right with the phones staff already carry: scan, receive, sell and
> count, and see what's about to run out and why.

**Live:** https://app10.breakthruventures.ai · **Runs on:** Azure · Part of
[30 apps in 30 days](https://github.com/BreakthruDevelopment/ai-dev-os)

## What this app does

Independent retailers, small warehouses, cafés and the agencies that build for them ask for "stock counts that stay
right without a scanner budget". They care that counts never silently drift (two people on one item can't
overwrite each other, and every change is in a ledger), that one shop never sees another's stock, and that forecasts
come with numbers they can check.

- **Workspaces.** Stock belongs to a team. Whoever creates a workspace is its manager and invites others with a
  link, as `manager` or `staff`.
- **Staff** scan a barcode with the phone camera or type a code or SKU, then **Receive**, **Sell**, **Adjust** (with
  a reason) or **Count**. They see each item's history and a ledger check.
- **Managers** do everything staff do, plus create and edit items (SKU, barcode, unit, reorder point, lead time,
  pack size, supplier, unit cost), manage members and invites, open the forecast, ask for a plain-language
  explanation, and download CSVs of items and the reorder list.
- **Admins** see counts only (workspaces, items, memberships, open invites, movements today, AI calls against the
  daily cap), load the demo workspace and manage accounts. An admin is not a member of any workspace and never sees
  item names or stock.

## Try it

1. Open https://app10.breakthruventures.ai and sign up (password of 10 or more characters).
2. On **Workspaces**, choose **Create workspace**. You are its manager.
3. In the workspace, **Create item** (add a barcode if you have a product to hand), then receive some stock.
4. Open **Scan** on a phone: allow the camera, or type the code under **Manual code**. Choose **Sell** or
   **Count**.
5. To try a second person, make an invite link on the team page (**Create invite link**) and open it while signed
   in as another account.

The forecast needs at least 7 days of sales history per item, so a brand-new item shows `no_data` and the
explanation makes no model call. **Load demo workspace** (admin only) creates "Demo Corner Store" with one manager,
two staff, six items and 60 days of movements, three of them selling faster in the last week. On the live site its
users get a random password that isn't shown, so nobody signs in as them. Locally, `pnpm seed:demo` sets a password
you choose (see [Run it locally](#run-it-locally)).

## The AI feature

**Numbers first** (`src/lib/forecast.ts`, deterministic and unit-tested). From the last 28 days of sales, for each
active item:

- `avg_daily` (units per day, averaged over the days of history, at most 28) and `trend` (last 7 days against that
  average);
- `days_of_cover` (on hand ÷ average), `stockout_date`, and `reorder_by` (when on hand reaches the reorder point,
  minus the lead time);
- `safety_stock` = ⌈0.5 × average × lead time⌉ and `suggested_qty` = average × (lead time + 14) + safety stock − on
  hand, rounded up to the pack size;
- **status:** `reorder_now` (at or below the reorder point, or cover shorter than the lead time), `reorder_soon`
  (cover shorter than lead time + 7 days), `ok`, or `no_data` (under 7 days of history or no sales; no forecast is
  made).

The forecast page shows this table on every visit, with or without AI.

**The explanation** (`reorder-explain`, `src/lib/forecast-explain.ts`): the manager chooses **Explain in plain
language**. It is one call to the shared gateway, `generate()` in `src/lib/ai`, with no tools. The live app is
deployed with `AI_PROVIDER=gemini` (default model `gemini-flash-lite-latest`; `AI_MODEL` overrides it).

- **The model never writes text.** It returns codes only: for each item its status, up to 3 "drivers" (such as
  `faster_sales` or `cover_shorter_than_lead_time`) and a note code, plus an overview code and caveat codes. The server
  renders every sentence from pre-written templates, using the computed numbers. Nothing the model is persuaded to
  say (a number, a buy instruction, a supplier or price claim) can reach the page.
- **Every code is checked** against the numbers. A driver or note whose condition is false is dropped. An item whose
  status differs from the computed one loses all its codes, and the template stands. Unknown item references are
  dropped, and items the model skipped get the template. `faster_sales` and `slower_sales` need a trend above 1.3 or
  below 0.7 and at least 3 units sold in the last week.
- **Input:** up to 25 items that need a reorder, most urgent first, as `I1`, `I2`, ... with their numbers. Names are
  stripped of angle brackets and control characters and capped at 80 characters; the workspace name isn't sent. At
  most 6,000 characters. The system prompt says names and values are data, not instructions.
- **Output** is validated with zod, leniently: a bad optional field loses only that field.
- **The app never places an order.** The explanation sits beside the table and **Download reorder list (CSV)**.
- **Caching and caps:** explanations are cached by a hash of the inputs and the provider setup, so the same numbers
  cost nothing. Otherwise 10 calls per workspace per hour and `FORECAST_DAILY_CAP` (default 150) per day app-wide,
  reserved before the call. Nothing to reorder means no call. Logs record task, mode, item count, replaced-field
  count and latency, never names.
- With `AI_FALLBACK_TO_DEMO=true` (the default), a quota error or outage serves a recorded answer, which goes through
  the same checks and is labelled as recorded.

Evals: `test/ai-evals.test.ts` (stubbed in CI); `pnpm eval:forecast` runs them against a live model by hand.

## Architecture

```
Phone browser (camera, on-device decoding)     Desktop browser
   │ HTTPS + session cookie (decoded string only)  │
   ▼                                               ▼
Next.js container ── pages, server actions, route handlers (/api/*)
   │                  auth + workspace membership, zod validation, AI gateway, JSON logs, /api/health
   ├──► Postgres (Drizzle): items, append-only stock ledger
   └──► Model API (Gemini, or recorded demo answers)
```

- **Azure Container Apps**, 0 to 1 replicas (0.25 vCPU, 0.5 GiB), with Azure Database for PostgreSQL Flexible
  Server. The replica runs only while people use the app plus a short cooldown, and the Build Tracker parks Azure
  apps rather than pinging them.
- **Why nothing is scheduled.** A scaled-to-zero replica gets no CPU on a timer, so there are no jobs, no nightly
  reconcile and no polling. Forecast numbers are computed with one query on each visit to the forecast page, and the
  explanation runs only when a manager asks. The template's job worker has no handlers and never starts.
- **Stock ledger.** `item.on_hand` is a cached balance and `stock_movement` is the ledger; both change in one
  transaction. Database triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on the ledger. The only deletions allowed
  are when the whole workspace is deleted (demo replacement and account removal). Each item page shows a ledger check
  (balance against the sum of movements).
- **Deltas** (receive, sell, adjust) are one conditional update that refuses to go below zero. Too few left returns
  409 "Only N left" with the current count.
- **Counts and item edits** need the version the person saw. A stale one returns 409 with the current count, version
  and the movements since. The dialog says, for example, "Someone recorded 1 sale while you were counting: recount or
  keep yours." **Keep mine** resubmits with the new version, as an explicit choice.
- **Idempotency.** Every movement carries a client-generated id, unique per workspace. A retry or double tap returns
  the first result without changing stock again.
- **Barcode scanning** happens in the browser, and no image leaves the phone (`src/components/scanner/`). It uses the
  browser's `BarcodeDetector` where available and otherwise loads `@zxing/browser` on the scan screen only. Formats:
  EAN-13, EAN-8, UPC-A, UPC-E, Code 128 and QR. The rear camera is used, with a torch toggle where supported, and the
  stream stops when you leave. Every page sends `Permissions-Policy: camera=(self)`. Manual entry is always on the
  same screen, so USB and Bluetooth scanners that type also work. The server accepts only the decoded string
  (`^[0-9A-Za-z.\-]{4,64}$`) and checks the GS1 check digit for 8, 12 and 13-digit codes.
- `GET /api/health` reports database and migration status and the deployed image tag, and returns 503 if the
  database is down.

## Data model

Defined in `src/lib/db/schema.ts`; migrations in `drizzle/`. Every inventory row carries `workspace_id`.

| Table | Holds |
| --- | --- |
| `workspace` | Name, time zone, creator |
| `membership` | (`workspace_id`, `user_id`) and role, `manager` or `staff`. The last manager can't leave or be demoted |
| `invite` | Token hash (SHA-256), role, 7-day expiry, used by and when, revoked time |
| `item` | SKU (unique per workspace), name, barcode (unique per workspace when set), unit, `on_hand` (never negative), reorder point, lead time, pack size, supplier, unit cost, archived time, `version` |
| `stock_movement` | Append-only ledger: kind (`receive`, `sale`, `adjust`, `count`), delta, balance after, item version, reason, actor, client operation id (unique per workspace) |
| `forecast_explanation` | Cached explanation codes per workspace and input hash |
| `forecast_call` | One row per model call, for the per-workspace hourly cap; deleted after an hour |
| `rate_event`, `daily_usage` | Per-user hourly limits and app-wide daily caps |
| `job` | The template's job queue table; unused here |

## Security

**Roles.** Global roles stay Better Auth's `user` and `admin`; workspace roles (`manager`, `staff`) live in
`membership`. Per-user ownership doesn't fit shared stock, and one shared inventory would let any sign-up vandalize
it. `src/lib/auth/permissions.ts` withholds impersonation, set-password, set-email and session listing from admins.

**Enforcement.**

- Every data function starts with `requireMember(actor, workspaceId, minRole)` (`src/lib/tenancy.ts`). A non-member
  gets **404**, never 403, so workspace ids can't be probed. A member without the role gets 403. Every query also
  filters on `workspace_id`, and composite foreign keys tie movements to items in the same workspace.
- **Invites.** 32 random bytes, only the SHA-256 is stored, role chosen, 7-day expiry, single use, revocable. At most
  10 open and 20 created per workspace per day. Every bad link (unknown, expired, revoked, used) gets the same 404,
  and accepting twice changes nothing. No email is sent; the manager copies the link.
- Mutating routes check the Origin header against `APP_URL`, cap JSON bodies at 16 KB and validate with zod. Errors
  go through `errorResponse()`, with no stack traces.
- **CSV exports** are quoted, and cells starting with `=`, `+`, `-` or `@` get a leading `'` to stop formula
  injection.
- Limits: 600 movements and 200 item writes per user per hour, 20 exports per user per hour, 3 workspaces created per
  user, 20 members and 2,000 items per workspace, 30 invite accepts per user per hour.
- Public sign-ups can't take the reserved demo email domain.

**Tests.** `test/stock-ledger.integration.test.ts` repeats concurrent sales and idempotency 20 times and reconciles
the ledger with the balance. `test/tenancy.integration.test.ts`, `test/tenancy-routes.integration.test.ts` and
`test/inventory-routes.integration.test.ts` call every route with a foreign workspace, and with a foreign item inside
one's own workspace. `test/forecast.integration.test.ts`, `test/account-removal.integration.test.ts` and
`test/admin-permissions.integration.test.ts` cover the forecast, account removal and admin limits. `scripts/smoke.sh`
runs the main flows over HTTP.

## Known limits

- **Scanner not yet tested on a physical phone.** The scanner has unit tests, and the live smoke checks the scan
  screen, manual entry and the camera policy, but the camera hasn't been tried on real Android and iPhone devices
  yet. Manual entry works either way. `/scanner-test`, a camera harness, answers 404 in production.
- **Long barcodes can't be looked up** ([issue #15](https://github.com/BreakthruDevelopment/10-inventory/issues/15)).
  Items accept barcodes up to 64 characters, but lookup and the scan screen use the 40-character SKU limit, so a
  41 to 64-character Code 128 or QR value can be saved but not found.
- **Cold starts.** The replica scales to zero, so the first visit after a quiet spell waits for it to start.
- Forecasts use the last 28 days of sales only: no seasonality or promotions, and nothing for items with under 7 days
  of history.
- Out of scope: multiple locations and transfers, purchase orders and supplier records, lots, serials and expiry, POS
  integrations, label printing, offline mode, imports and valuation methods.

## Free-tier budget

| Resource | Control |
| --- | --- |
| Container Apps (free grant shared by every Azure app) | At most 1 replica; runs only during visits; no timers or polling; scanning uses no server CPU |
| Postgres Flexible Server (shared) | Caps above; a movement row is small |
| Gemini | Only on request, cached by input hash; 10 per workspace per hour, `FORECAST_DAILY_CAP` per day |
| Egress | The ZXing decoder loads only on the scan screen, and only where the browser lacks `BarcodeDetector` |

## Configuration

Names only; values live in the cloud's secret store or `.env.local`. See `.env.example` and `src/lib/env.ts`.

| Variable | Purpose |
| --- | --- |
| `APP_URL`, `APP_NAME` | Public URL (also the only allowed Origin and the base of invite links) and display name |
| `DATABASE_URL` | Postgres connection |
| `BETTER_AUTH_SECRET` | Session signing, at least 32 characters |
| `AI_PROVIDER`, `AI_MODEL`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Model choice (`demo`, `gemini` or `anthropic`) |
| `AI_FALLBACK_TO_DEMO`, `AI_TIMEOUT_MS`, `FORECAST_DAILY_CAP` | Fallback to recorded answers, provider timeout (max 22 s), app-wide daily explanations |
| `MIGRATE_ON_START` | Apply migrations at startup (on in the cloud) |
| `LOG_LEVEL` | JSON log level |

## Run it locally

```bash
cp .env.example .env.local          # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db             # Postgres 17
pnpm install
pnpm db:migrate
pnpm dev                            # http://localhost:3000
```

`AI_PROVIDER=demo` (the default) needs no key or network. To make yourself an admin, sign up, then run
`SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm db:seed` while the app is running. To load Demo Corner
Store with a password you can sign in with (as `maya@demo.breakthru.test`, the manager), run
`DEMO_SEED=yes DEMO_PASSWORD='<a local password>' pnpm seed:demo`. It refuses production hosts and databases. The
camera needs `localhost` or HTTPS.

Checks:

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests
TEST_DATABASE_URL=postgres://... pnpm test # plus integration tests against real Postgres
pnpm build && pnpm smoke                   # HTTP smoke test against a running app (BASE_URL)
```

## Deploy it yourself

Every push to `main` publishes a multi-arch image to `ghcr.io/breakthrudevelopment/10-inventory:sha-<commit>`.
[30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra) deploys a pinned tag with Terraform. The same
image runs on AWS (Lambda), Azure (Container Apps), Google Cloud (Cloud Run) and Oracle Cloud (Docker on a VM); see
`infra/README.md`. This repo holds no cloud credentials. With `MIGRATE_ON_START=true`, the server applies pending
migrations, including the ledger triggers, before taking traffic.

## 2-minute demo script

You need a manager account and a staff account (joined through an invite link), and two phones. For the forecast,
use a workspace with at least a week of sales (locally, the seeded Demo Corner Store).

1. **Staff scans and sells.** On phone 1, open **Scan**, point the camera at the item's barcode (or type it under
   **Manual code**), then **Sell** 1. *Proves: phone-camera scanning with on-device decoding, and an atomic sale.*
2. **A stale count meets the conflict dialog.** On phone 2, open the same item and start a **Count** before step 1,
   then submit it after. The dialog says someone recorded a sale while you were counting and offers **Recount** or
   **Keep mine**. *Proves: counts never silently overwrite each other.*
3. **The ledger holds.** On the item page, the history lists every movement and the ledger check matches the
   balance. *Proves: an append-only ledger behind every number.*
4. **Manager opens the forecast.** **Forecast** lists items with average daily sales, trend, days of cover, reorder-by
   date and suggested quantity. *Proves: deterministic numbers anyone can check.*
5. **Ask for the explanation.** Choose **Explain in plain language**. Each item gets sentences built from its own
   numbers, for example that sales pace has picked up and cover is shorter than the lead time. *Proves: AI that can
   only choose among checked facts, never invent them.*
6. **Download the reorder list.** **Download reorder list (CSV)** gives the items to reorder with the computed
   quantities. *Proves: the app suggests; a person orders.*
