/* DoR NAVIGATE adapter — LIVE wiring (verified 2026-10-07).
 *
 * Base: https://navigate.dor.gov.np/api — no auth needed for public closure data.
 *
 * Endpoints:
 *  1. GET  /Map_data_api/getRoadClosureMapData          -> {"data":[...]}  PRIMARY live feed
 *  2. GET  /Map_data_api/getRecentlyOpenedRoadsMapData  -> recently reopened roads
 *  3. POST /Road_closure_history_api/getHistoryPaginated -> JSON body {page:1, ...filters}
 *  4. GET  /Road_api/getAllRoadsWithLinks                -> road list with links
 *  5. POST /Srn_api/fetchGeoJsonForRoadRefs              -> JSON body {road_refs:["NH17",...]}
 *
 * Record fields (live feed): id, date_created, latitude, longitude, road_name,
 * closure_reason, repair_eta ("1 days", "4 hours"), road_refno ("NH37","NH03",
 * "NH13","NH42"), district, division, closure_type ("CLOSED"; UI also shows
 * "Partially Opened" / "Opened Roads"), date_roadblock_start,
 * date_roadblock_end_estimated, date_roadblock_end (null = still blocked),
 * chainage, end_chainage, link_code ("NH37-003"), location, contact_person,
 * efforts_being_made, remarks.
 *
 * Behaviour: refetch at most every 15 minutes; last good payload is kept in
 * localStorage for offline use; on any failure the app falls back to seed data
 * and shows "live feed unreachable — showing last-known data".
 */

const NAVIGATE_CONFIG = {
  BASE: "https://navigate.dor.gov.np/api",
  CLOSURE_MAP: "Map_data_api/getRoadClosureMapData",
  RECENTLY_OPENED: "Map_data_api/getRecentlyOpenedRoadsMapData",
  HISTORY: "Road_closure_history_api/getHistoryPaginated",
  ROADS: "Road_api/getAllRoadsWithLinks",
  GEOJSON: "Srn_api/fetchGeoJsonForRoadRefs",
  TIMEOUT_MS: 8000,
  REFETCH_MINUTES: 15,
  LS_PAYLOAD: "bato_navigate_payload",
  LS_FETCHED_AT: "bato_navigate_fetched_at",
};

/* Known road-ref -> corridor mappings for our v1 corridors. */
const ROAD_REF_TO_CORRIDOR = {
  NH17: "prithvi",     // Prithvi Highway
  NH44: "nh44",        // Narayanghat–Mugling road
  NH13: "bp",          // BP Highway
  NH37: "kanti",       // Kanti Lokpath
};
/* Corridors fully covered by the live feed: no closure record = OPEN. */
const LIVE_COVERED_REFS = new Set(Object.keys(ROAD_REF_TO_CORRIDOR));
/* Name-based fallback for corridors without a confirmed NH ref yet. */
const NAME_TO_CORRIDOR = [
  { match: ["tribhuvan"], corridor: "tribhuvan" },
  { match: ["pharping", "kulekhani", "phakhel", "sisneri"], corridor: "pharping" },
];

/* Map DoR's closure_type strings to the app's status enum. */
function navigateStatusToApp(closureType) {
  const s = String(closureType || "").toLowerCase();
  if (s.includes("partial")) return "PARTIAL";
  if (s.includes("closed")) return "CLOSED";
  if (s.includes("opened") || s === "open") return "OPEN";
  return "UNKNOWN";
}

/* Normalize one raw DoR record to the app's segment-event shape. */
function normalizeNavigateRecord(r) {
  return {
    id: r.id,
    highway_code: String(r.road_refno || "").toUpperCase(),
    road_name: r.road_name || "",
    link_code: r.link_code || "",
    location: r.location || "",
    chainage: r.chainage || null,
    end_chainage: r.end_chainage || null,
    status: navigateStatusToApp(r.closure_type),
    closure_type_raw: r.closure_type || "",
    reason: r.closure_reason || "",
    repair_eta: r.repair_eta || "",
    district: r.district || "",
    division: r.division || "",
    contact_person: r.contact_person || "",
    efforts: r.efforts_being_made || "",
    remarks: r.remarks || "",
    closed_since: r.date_roadblock_start || null,
    est_reopen: r.date_roadblock_end_estimated || null,
    date_created: r.date_created || null,
    lat: r.latitude != null ? Number(r.latitude) : null,
    lng: r.longitude != null ? Number(r.longitude) : null,
    source_name: "DoR NAVIGATE",
    source_url: "https://navigate.dor.gov.np",
  };
}

/* Which of our corridors does a live record belong to? */
function corridorForRecord(rec) {
  if (rec.highway_code && ROAD_REF_TO_CORRIDOR[rec.highway_code]) {
    return ROAD_REF_TO_CORRIDOR[rec.highway_code];
  }
  const hay = ((rec.road_name || "") + " " + (rec.location || "")).toLowerCase();
  for (const m of NAME_TO_CORRIDOR) {
    if (m.match.some((k) => hay.includes(k))) return m.corridor;
  }
  return null;
}

/* Raw live fetch. Returns {records, fetchedAt}. Throws on any failure. */
async function fetchLiveClosures() {
  const { BASE, CLOSURE_MAP, TIMEOUT_MS } = NAVIGATE_CONFIG;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/${CLOSURE_MAP}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const rows = Array.isArray(json) ? json : json.data || [];
    return {
      records: rows.map(normalizeNavigateRecord).filter(Boolean),
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* Throttled (15 min), localStorage-backed accessor.
 * Returns {records, fetchedAt, live, cached} — never throws.
 * live=false means the fetch failed and we are on stored/seed data. */
async function getNavigateRecords() {
  const { LS_PAYLOAD, LS_FETCHED_AT, REFETCH_MINUTES } = NAVIGATE_CONFIG;
  let stored = null,
    storedAt = null;
  try {
    stored = JSON.parse(localStorage.getItem(LS_PAYLOAD) || "null");
    storedAt = localStorage.getItem(LS_FETCHED_AT);
  } catch (e) {
    /* storage unavailable — continue without cache */
  }
  const freshEnough =
    stored &&
    storedAt &&
    Date.now() - new Date(storedAt).getTime() < REFETCH_MINUTES * 60 * 1000;
  if (freshEnough) {
    return { records: stored.records, fetchedAt: storedAt, live: true, cached: true };
  }
  try {
    const { records, fetchedAt } = await fetchLiveClosures();
    try {
      localStorage.setItem(LS_PAYLOAD, JSON.stringify({ records }));
      localStorage.setItem(LS_FETCHED_AT, fetchedAt);
    } catch (e) {
      /* ignore */
    }
    return { records, fetchedAt, live: true, cached: false };
  } catch (e) {
    if (stored) {
      return { records: stored.records, fetchedAt: storedAt, live: false, cached: true };
    }
    return { records: null, fetchedAt: null, live: false, cached: false };
  }
}

/* Fuzzy match: does this live record describe this segment? */
function recordMatchesSegment(rec, segName) {
  const seg = segName.toLowerCase();
  const words = (s) =>
    String(s || "")
      .toLowerCase()
      .split(/[^a-z\u0900-\u097F0-9]+/)
      .filter((w) => w.length >= 4);
  const cands = [rec.location, rec.road_name, rec.link_code].filter(Boolean);
  return cands.some((c) => {
    const cs = String(c).toLowerCase();
    if (seg.includes(cs) || cs.includes(seg)) return true;
    const cw = words(cs),
      sw = words(seg);
    return cw.some((w) => sw.includes(w)) || sw.some((w) => cw.includes(w));
  });
}

/* Merge live DoR records into the seeded corridor list.
 * Rule: for a corridor with live coverage (NH17/NH44/NH13/NH37), a segment with
 * no live closure record is OPEN — the feed itself is the confirmation, and
 * updated_at is set to the feed fetch time so the "updated x ago" rule stays
 * honest. Corridors without a confirmed NH ref keep seed data unless a record
 * matches them by name. Returns {corridors, feed}. */
function mergeNavigateIntoCorridors(corridors, nav) {
  const feed = {
    ok: false,
    live: !!(nav && nav.live),
    fetchedAt: nav ? nav.fetchedAt : null,
    count: nav && nav.records ? nav.records.length : 0,
  };
  if (!nav || !nav.records) return { corridors, feed };
  const byCorridor = {};
  nav.records.forEach((r) => {
    const c = corridorForRecord(r);
    if (c) (byCorridor[c] = byCorridor[c] || []).push(r);
  });
  const fetchedAt = nav.fetchedAt;
  const liveStatus = (s, rec) => ({
    ...s,
    status: rec ? rec.status : "OPEN",
    cause: rec ? rec.reason || s.cause : "",
    note: rec
      ? [
          rec.reason,
          rec.efforts ? "Efforts: " + rec.efforts : "",
          rec.repair_eta ? "ETA: " + rec.repair_eta : "",
          rec.location ? "(" + rec.location + ")" : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "No closure reported on the live DoR feed.",
    updated_at: fetchedAt,
    source_name: "DoR NAVIGATE",
    source_url: "https://navigate.dor.gov.np",
    confidence: "official",
  });
  const merged = corridors.map((c) => {
    const recs = byCorridor[c.id] || [];
    const covered = c.code && LIVE_COVERED_REFS.has(c.code);
    if (!recs.length && !covered) return c; // no live info — keep seed data
    const segments = c.segments.map((s) => {
      const hit = recs.find((r) => recordMatchesSegment(r, s.name));
      if (hit) return liveStatus(s, hit);
      if (covered) return liveStatus(s, null); // feed covers it, no closure = open
      return s;
    });
    return { ...c, segments };
  });
  feed.ok = true;
  return { corridors: merged, feed };
}

/* --- Bonus readers (wired to real endpoints; used by later versions) --- */

async function fetchRecentlyOpenedRoads() {
  const { BASE, RECENTLY_OPENED, TIMEOUT_MS } = NAVIGATE_CONFIG;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/${RECENTLY_OPENED}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const rows = Array.isArray(json) ? json : json.data || [];
    return rows.map(normalizeNavigateRecord).filter(Boolean);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRoadList() {
  const { BASE, ROADS, TIMEOUT_MS } = NAVIGATE_CONFIG;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(`${BASE}/${ROADS}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function fetchClosureHistory(page, filters) {
  const { BASE, HISTORY, TIMEOUT_MS } = NAVIGATE_CONFIG;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(`${BASE}/${HISTORY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: page || 1, ...(filters || {}) }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

/* GeoJSON geometry per road ref — for drawing routes on a map later. */
async function fetchGeoJsonForRoadRefs(roadRefs) {
  const { BASE, GEOJSON, TIMEOUT_MS } = NAVIGATE_CONFIG;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(`${BASE}/${GEOJSON}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ road_refs: roadRefs }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}
