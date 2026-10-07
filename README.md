# Bato Update — Nepal road status (v1)

**Is the road open?** A mobile-first installable web app (PWA) that shows the
latest road status for Nepal's highways — per corridor and per segment:
**Open / One-way / Partial / Closed / Unknown**, with the reason, when it was
last confirmed, the source, and alternative routes.

Live at: `https://daveyadav.github.io/weatherapp/` (GitHub Pages must be
enabled on the repo: Settings → Pages → Deploy from branch → `main` → `/ (root)`)

## How it works

- **Seed data** (`data/routes.json`) — 6 v1 corridors with named chokepoint
  segments, seeded from news reports dated 2026-10-05/06. Statuses older than
  24h are displayed grey as *possibly outdated*, never a confident green.
- **Live feed** (`js/navigate.js`) — pulls the Department of Roads NAVIGATE
  closure feed (`GET https://navigate.dor.gov.np/api/Map_data_api/getRoadClosureMapData`,
  verified live 2026-10-07, no auth). Records carry `road_refno` (NH17 Prithvi,
  NH44 Narayanghat–Mugling, NH13 BP, NH37 Kanti), `closure_type`, `closure_reason`,
  `repair_eta`, lat/lng, etc. For corridors with live coverage, a segment with
  no closure record = OPEN, stamped with the feed fetch time. Refetch at most
  every 15 minutes; last good payload kept in `localStorage` for offline use.
  If the fetch fails (network/CORS), the app falls back to seed data and shows
  "live feed unreachable — showing last-known data".
- **Offline** — service worker caches the shell + seed data; an "Offline —
  showing last-known data" banner appears when the device is offline.
- **Version footer** (`v1 • 2026-10-07`) — diagnoses stale phone caches.

## Data sources

1. DoR NAVIGATE (navigate.dor.gov.np) — official per-section closures, live feed
2. Nepal Traffic Police — holds, releases, one-way rulings
3. News (Rising Nepal Daily, OnlineKhabar, Khabarhub, The Himalayan Times) — backup
4. DHM weather — risk context only, never shown as a closure (v2)

## v1 corridors

1. Prithvi Highway, Kathmandu–Pokhara via Muglin (NH17)
2. Narayanghat–Mugling road (NH44)
3. Tribhuvan Highway, Naubise–Hetauda
4. BP Highway, Dhulikhel–Bardibas (NH13)
5. Kanti Lokpath, Satdobato–Hetauda (NH37)
6. Pharping–Phakhel–Kulekhani–Bhimphedi, Kathmandu–Hetauda south route

## Updating statuses

- Automatic: the NAVIGATE live feed refreshes segments on every app open
  (throttled to 15 min).
- Manual: edit `data/routes.json` (one entry per segment: `status`, `cause`,
  `note`, `updated_at` ISO with +05:45, `source_name`, `source_url`) and push.
  Bump `APP_VERSION` in `js/app.js`, the footer in `index.html`, and the
  service-worker `CACHE` name in `sw.js` so phones pick up the new build.

## Tech

Vanilla HTML/CSS/JS, no frameworks. PWA: `manifest.json` + `sw.js`.
No backend — static hosting on GitHub Pages.
