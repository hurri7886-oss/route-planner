# Route Planner — Standalone v1 (Option 2)

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

## Features (v1)

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

## Data storage — v1 limitation

Data is stored in **browser localStorage on each user's own device**
(key `route-planner-v2`). Team members do **not** yet share one live
database, and clearing browser data clears the app's data — use the JSON
backup export.

## Next step: Supabase (shared live database)

Not yet integrated — the user's Supabase project URL and anon key are not
available yet, and no credentials have been invented.
`config.js` contains clearly marked placeholders:

```js
window.RP_CONFIG = { SUPABASE_URL: "", SUPABASE_ANON_KEY: "" };
```

To finish it: in the user's Supabase project, create tables mirroring the
state shape (customers, vehicles, depots/dispatch points, planner settings,
routes), paste the project URL + **anon/public** key (never the
service_role key or DB password) into `config.js`, and swap the
`load()`/`save()` localStorage layer in `app.js` for Supabase reads/writes.

## Hosting / deployment

- **GitHub**: repo `route-planner` under `hurri7886-oss`.
  ⚠ Status at build time: creating the repository through the Muse GitHub
  connector failed with
  `403 Resource not accessible by integration` on
  `POST https://api.github.com/user/repos`, and the repo does not yet exist
  (GET repo → 404). The account owner needs to either create the empty repo
  `route-planner` manually on github.com, or adjust the Muse GitHub App
  installation permissions — after that, these files can be pushed with the
  connector's `push_files` in one commit.
- **Vercel**: deploy as a static project (no build command, output = repo
  root). A direct file deployment via the Vercel connector's
  `create_deployment` (files under `requestBody`) is the fallback while the
  GitHub repo is blocked.
  ⚠ Status at build time: `upload_file` (POST /v2/files) failed with
  `403 forbidden — Not authorized: Trying to access resource under scope
  "hurri7886-2286"` (teamId `team_TBQMVES0uYL9Ea2bNr0HUHdF`). The API's
  recovery step is `authorize_team_access` for that team, but that tool is
  not in the Muse Vercel connector's reviewed tool list, so the account
  owner must approve team access / re-authenticate to that scope first.
  After that, retry the uploads + `create_deployment` and check the
  deployment's returned URL/status before treating it as live.
  (Seed data is split into `seed1.json`/`seed2.json`, ~65 KB each, so each
  file stays within the connector's upload argument limits.)

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell / all panels |
| `styles.css` | Locus-style console styling + Full Picture mode |
| `app.js` | All logic: seed load, planning, rendering, import/export |
| `seed1.json` + `seed2.json` | 500 customers (short keys, split in two), 71 vehicles, 5 dispatch points |
| `config.js` | Supabase placeholders (next step) |
| `vercel.json` | Static hosting config for Vercel |
