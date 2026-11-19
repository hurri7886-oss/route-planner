# Route Planner — Standalone v3 (Option 2)

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

## Features (v3)

- **Team logins (Supabase Auth)** — the app opens on a login screen and
  loads **no data** until a team member signs in with their own email +
  password. Accounts are created by the admin only (Supabase dashboard →
  Authentication → Users → Add user); there is **no public sign-up** in
  the app, and public sign-ups should be turned OFF in Supabase
  (Authentication → Settings). The header shows the signed-in email and
  a **Sign out** button; an expired session returns the user to the
  login screen with a note.
- **Accountability** — every save is stamped with the saver's email
  (`app_state.updated_by`; the header shows *“Last saved by …”*) and a
  plain-words summary is logged to `public.app_changes`
  (e.g. “Customers per truck 90 → 75”, “Routes replanned (28 routes)”).
  ⚙ Advanced has a **Change history — who changed what** section
  (latest 30 entries, PKT times) with a refresh button.

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
- **Real street map** (Leaflet 1.9.4, vendored in `vendor/` — no CDN at
  runtime) with free Esri World Street Map tiles (no API key;
  `tile.openstreetmap.org` is deliberately not used — its tile policy
  blocked us before). Each route is a coloured polyline from its
  dispatch point with numbered stop pins in the route colour; amber
  **D** pins are dispatch points. If Leaflet or the tiles fail to load,
  the app automatically falls back to the schematic SVG plot. A legend
  under the map explains the pins. Each route also has an **Open in
  Google Maps** link.
- **Editable dispatch points**: rename a warehouse / mini shop or move
  it — either in ⚙ Advanced (name + latitude/longitude inputs per point)
  or directly on the map: **drag an amber D pin** to move the point,
  **click a D pin** to rename it in its popup. Existing routes are
  recalculated from the new location immediately, and every change is
  saved to the shared state and the change log. On the schematic
  fallback, clicking a D opens the Advanced editor for that point.
- **Click any stop pin** (street map or schematic) to open the stop
  panel: customer name, address, area, bottles, delivery days, phone,
  current route/vehicle and stop number — plus **↑/↓ reorder**, a
  **Move to another route** control (same-day routes; bottle-capacity
  blocked with a warning), and **Remove from route (keep unassigned)**.
- **Unassigned pool** — a removed customer is not deleted and stays
  ticked for the week; it waits in `state.unassigned` per day, shows as
  a grey dashed **!** pin on the map and in the **⚠ Unassigned** panel
  under the route cards (with a warning badge by the route count),
  ready to be added to any route for that day (capacity rules apply).
  **Plan Routes** replans everyone and empties the pool.
- Route detail: stops in order, ↑/↓ reorder, move a customer to another
  route (bottle-capacity blocked with a warning), re-optimise one route —
  all recalculated and saved (same shared move/reorder logic as the
  stop panel).
- 📸 Full Picture one-screen overview for a top-to-bottom screenshot.
- CSV import/export of customers, JSON full backup export, add-customer
  form, editable dispatch point names/locations, reset-to-seed.

## Data storage — v3: Supabase shared database + logins

v3 keeps **Supabase** as the shared team database and adds **team
logins with accountability**, so the team can always see who changed
what:

- **Login gate first.** On load, the app checks for a valid Supabase
  Auth session (stored in localStorage, refreshed automatically via
  the refresh token). With no valid session it shows only the login
  screen — no data is fetched or rendered. All data calls send the
  signed-in **user's access token** (`Authorization: Bearer …`); the
  publishable key is still sent as the `apikey` header but no longer
  grants data access by itself.
- The whole app state (customers, vehicles, dispatch points, settings,
  routes) lives in **one row** of `public.app_state`
  (`id = 'route-planner'`, `state` jsonb) in the project
  `https://tcvcirrpomlrirkbgikw.supabase.co`.
- On startup (after login) the app reads that row first. If the shared
  state is empty, it initialises from the bundled seed files and
  uploads the full state. If Supabase is unreachable, it falls back to
  the local cache/seed and the header shows **“Offline copy — changes
  not shared yet”**; when connected it shows **“Shared data:
  connected · Last saved by \<email\>”**.
- Every change is written to **localStorage immediately** (device-local
  offline backup, key `route-planner-v2`) and **PATCHed to Supabase**
  (debounced ~800 ms) with `updated_by` set to the saver's email. Each
  debounced save also inserts one row into **`public.app_changes`**
  (`user_email`, `summary`) — best-effort, so a log failure never
  blocks a save. The summary is built from a shallow diff against the
  last loaded/saved state.
- `config.js` holds the project URL and the **publishable (anon) key**,
  which is public by design and safe to embed in browser code. The
  Supabase **secret key must never** go in this app.
- Auth uses the Supabase Auth REST API directly (no SDK):
  `POST /auth/v1/token?grant_type=password` to sign in,
  `grant_type=refresh_token` to refresh, `POST /auth/v1/logout` to
  sign out.

**Required database setup (v3 SQL, run once in the Supabase SQL
Editor):** on `public.app_state` add an `updated_by` column; create
`public.app_changes (id, changed_at, user_email, summary)` with RLS;
**drop the old anon policies**; and allow **only role
`authenticated`** to select/insert/update `app_state` and
select/insert `app_changes`. Until that SQL is run, the previous anon
policies still apply (the app stays compatible: it retries state
reads/writes without `updated_by` if the column is missing, and the
change log silently no-ops if the table is missing).

**Admin checklist for accounts:** Supabase dashboard →
Authentication → Users → **Add user** for each team member (email +
password); Authentication → Settings → **disable public sign-ups**
(“Allow new users to sign up” OFF). Team members cannot create their
own accounts from the app.

**Security posture (v3):** only signed-in team members can read or
write the shared data; every save is attributed to a named user in
`app_state.updated_by` and `public.app_changes`. Keep using the JSON
backup export as an extra safety copy.

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
| `index.html` | App shell / all panels (incl. login screen + change history) |
| `styles.css` | Locus-style console styling + Full Picture mode + login screen |
| `app.js` | All logic: Supabase Auth login gate, seed load, planning, rendering, import/export, change log + history |
| `seed1.json` + `seed2.json` | 500 customers (short keys, split in two), 71 vehicles, 5 dispatch points |
| `config.js` | Supabase project URL + publishable key (v3: shared storage + logins) |
| `vendor/leaflet.js`, `vendor/leaflet.css`, `vendor/images/` | Leaflet 1.9.4 vendored locally (map library — no CDN at runtime) |
| `vercel.json` | Static hosting config for Vercel |
