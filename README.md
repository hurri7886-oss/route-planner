# Route Planner — Standalone v2 (Option 2)

A dependency-free static web app (plain HTML/CSS/JS, no build step, no paid
maps, no API keys) for the Nestlé Waters Lahore 19L home & business delivery
operation. It mirrors the Muse artifact's core workflow and can be hosted on
Vercel (or any static host) so the team can use it without Muse.

## Real Lahore operating data (seed)

Lahore is the first/biggest metro. The seed reflects the real numbers given
by the user (2026-11-19), **not** the earlier sample assumptions
(superseded: 6 trucks × 400 bottles, single Kot Lakhpat depot):

- **Fleet: 71 vehicles**
  - 55 × Mazda — **160 bottles** capacity each
  - 6 × Shehzore — **90 bottles** each
  - 10 × Ravi / Pick-up — **60 bottles** each
- **Dispatch points: 5** — 3 major warehouses + 2 mini water shops
  (`Warehouse 1`, `Warehouse 2`, `Warehouse 3`, `Mini Shop 1`, `Mini Shop 2`).
  Exact names/addresses were not provided, so **none have been invented**:
  each point has an approximate Lahore map position for its customer cluster
  and an editable name/location in ⚙ Advanced. Every customer and vehicle is
  assigned to one dispatch point; routes start and end at that point.
- **Customers: 500 sample customers**, 100 in each of 5 Lahore areas
  (DHA/Cantt, Gulberg/Garden Town, Johar Town/Wapda Town,
  Bahria Town/Valencia, Iqbal Town/Samanabad), each assigned to the dispatch
  point for its area. Sample data — replace with real accounts.
- **Customers per truck: team-editable in the app** (default 90, range
  10–200, quick choices 50/75/90/120). The team changes this daily on the
  main screen; no developer/Muse visit is needed.

## Features (v2)

- Locus-style dispatch console (layout pattern only): day selector Mon–Sat,
  one **Plan Routes** button, KPI strip (routes, customers served, km,
  bottles, vehicles used out of 71, avg customers/vehicle vs target,
  5 dispatch points).
- **This Week serve/skip**: Serve all / Skip all / Serve only N (balanced
  across the 5 areas, e.g. 300 of 500) / per-area All-Skip / one-by-one
  checklist with search. Skipped customers are never deleted.
- **Plan Routes**: per dispatch point — geographic (bearing) assignment to
  that point's vehicles, balanced by the customers-per-truck setting,
  split when a day's load exceeds the vehicle's bottle capacity
  (Mazda 160 / Shehzore 90 / Ravi 60), stops sequenced nearest-neighbour +
  2-opt on each customer's locked delivery days.
- Route cards + schematic route plot (pins, lines, dispatch points).
  **No map tiles are used** (OpenStreetMap tiles returned 403 in the
  artifact); each route has an **Open in Google Maps** link instead.
- Route detail: stops in order, ↑/↓ reorder, move a customer to another
  route (bottle-capacity blocked with a warning), re-optimise one route —
  all recalculated and saved.
- 📸 Full Picture one-screen overview for a top-to-bottom screenshot.
- CSV import/export of customers, JSON full backup export, add-customer
  form, editable dispatch point names/locations, reset-to-seed.

## Data storage — v2: Supabase shared database

v2 is wired to **Supabase** as the shared team database, so every team
member works on the same live data:

- The whole app state (customers, vehicles, dispatch points, settings,
  routes) lives in **one row** of `public.app_state`
  (`id = 'route-planner'`, `state` jsonb) in the project
  `https://tcvcirrpomlrirkbgikw.supabase.co`.
- On startup the app reads that row first. If the shared state is empty,
  it initialises from the bundled seed files and uploads the full state.
  If Supabase is unreachable, it falls back to the local cache/seed and
  the header shows **“Offline copy — changes not shared yet”**; when
  connected it shows **“Shared data: connected”**.
- Every change is written to **localStorage immediately** (offline cache,
  key `route-planner-v2`) and **PATCHed to Supabase** (debounced ~800 ms).
- `config.js` holds the project URL and the **publishable (anon) key**,
  which is public by design and safe to embed in browser code. The
  Supabase **secret key must never** go in this app.
- Table setup (run once in the Supabase SQL Editor): create
  `public.app_state (id text primary key, state jsonb not null,
  updated_at timestamptz not null default now())`, enable RLS, add
  policies allowing the anon role select/insert/update, and insert the
  row `('route-planner', '{}')`.

**Pilot security posture:** anyone who has the app link + the publishable
key can read/write this one `app_state` table (the RLS policies allow the
anon role full read/write on that table only). That is acceptable for an
internal pilot; **add user logins (Supabase Auth) and tighten the
policies before any wider rollout.** Keep using the JSON backup export
as an extra safety copy.

## Hosting / deployment

- **GitHub**: repo `route-planner` under `hurri7886-oss`
  (https://github.com/hurri7886-oss/route-planner) — created by the account
  owner and added to the Muse GitHub App installation; code is pushed
  with the connector's `push_files`.
- **Vercel**: live at https://route-planner-fawn.vercel.app — the owner
  imported the GitHub repo in the Vercel dashboard (static project, no
  build command, output = repo root), so **every push to GitHub
  auto-deploys** to that URL.
  (Seed data is split into `seed1.json`/`seed2.json`, ~65 KB each, so each
  file stays within the connector's upload argument limits.)

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell / all panels |
| `styles.css` | Locus-style console styling + Full Picture mode |
| `app.js` | All logic: seed load, planning, rendering, import/export |
| `seed1.json` + `seed2.json` | 500 customers (short keys, split in two), 71 vehicles, 5 dispatch points |
| `config.js` | Supabase project URL + publishable key (v2 shared storage) |
| `vercel.json` | Static hosting config for Vercel |
