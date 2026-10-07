/* Bato Update — Nepal road status PWA (v1)
 * Single rename point for the app name: APP_NAME below (+ manifest.json,
 * sw.js cache name is versioned separately).
 */
const APP_NAME = "Bato Update";
const APP_VERSION = "v1 • 2026-10-07";

const STATUS_META = {
  OPEN:    { label: "Open",    np: "खुला",    cls: "open" },
  ONE_WAY: { label: "One-way", np: "एकतर्फी", cls: "one_way" },
  PARTIAL: { label: "Partial", np: "आंशिक",   cls: "partial" },
  CLOSED:  { label: "Closed",  np: "बन्द",    cls: "closed" },
  UNKNOWN: { label: "Unknown", np: "अज्ञात",   cls: "unknown" },
};
/* Worst-first order for deriving a corridor verdict from its segments. */
const SEVERITY = { CLOSED: 4, UNKNOWN: 3, PARTIAL: 2, ONE_WAY: 1, OPEN: 0 };
/* Freshness thresholds (ms). Older than STALE_MS => "possibly outdated", never green. */
const AGING_MS = 2 * 3600 * 1000;
const STALE_MS = 24 * 3600 * 1000;

let DATA = null;   // routes.json content (after NAVIGATE merge)
let FEED = { ok: false, live: false, fetchedAt: null, count: 0 };

/* ---------- helpers ---------- */

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function ageMs(iso) {
  const t = new Date(iso).getTime();
  return isNaN(t) ? Infinity : Date.now() - t;
}

function ageLabel(iso) {
  const ms = ageMs(iso);
  if (!isFinite(ms)) return "time unknown";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " hr ago";
  const d = Math.floor(h / 24);
  return d + (d === 1 ? " day ago" : " days ago");
}

function isStale(iso) {
  return ageMs(iso) > STALE_MS;
}
function isAging(iso) {
  const ms = ageMs(iso);
  return ms > AGING_MS && ms <= STALE_MS;
}

/* A stale status is displayed as UNKNOWN-grey ("possibly outdated") — never green. */
function displayStatus(seg) {
  return isStale(seg.updated_at) ? "UNKNOWN" : seg.status;
}

function chip(status, extra) {
  const st = displayStatus({ status, updated_at: extra && extra.updated_at });
  const meta = STATUS_META[st] || STATUS_META.UNKNOWN;
  const staleNote = extra && isStale(extra.updated_at) ? " · possibly outdated" : "";
  return `<span class="chip chip-${meta.cls}${extra && isStale(extra.updated_at) ? " chip-stale" : ""}">${meta.label} <span class="np">${meta.np}</span>${staleNote}</span>`;
}

function corridorVerdict(c) {
  let worst = "OPEN",
    decider = null;
  c.segments.forEach((s) => {
    const ds = displayStatus(s);
    if (SEVERITY[ds] > SEVERITY[worst]) {
      worst = ds;
      decider = s;
    }
  });
  return { status: worst, decider };
}

function corridorById(id) {
  return DATA.corridors.find((c) => c.id === id);
}
function placeName(id) {
  const p = DATA.places.find((p) => p.id === id);
  return p ? p.name : id;
}

/* ---------- data loading ---------- */

async function loadData() {
  const res = await fetch("data/routes.json", { cache: "no-store" });
  if (!res.ok) throw new Error("routes.json not found");
  const raw = await res.json();
  let corridors = raw.corridors;
  // Try the live DoR feed (throttled + cached inside getNavigateRecords).
  try {
    const nav = await getNavigateRecords();
    const merged = mergeNavigateIntoCorridors(corridors, nav);
    corridors = merged.corridors;
    FEED = merged.feed;
  } catch (e) {
    FEED = { ok: false, live: false, fetchedAt: null, count: 0 };
  }
  DATA = { ...raw, corridors };
}

function feedBanner() {
  if (FEED.ok && FEED.live) {
    const when = FEED.fetchedAt ? ageLabel(FEED.fetchedAt) : "just now";
    return `<div class="alert feed-ok">🟢 Live DoR feed · ${FEED.count} closure records · fetched ${esc(when)}</div>`;
  }
  if (FEED.fetchedAt) {
    return `<div class="alert">🟠 Live feed unreachable — showing last-known data (fetched ${esc(ageLabel(FEED.fetchedAt))})</div>`;
  }
  return `<div class="alert">🟠 Live DoR feed unreachable — showing seed data from 2026-10-06/07. Check source links before you travel.</div>`;
}

/* ---------- views ---------- */

function viewHome() {
  const cards = DATA.corridors
    .map((c) => {
      const v = corridorVerdict(c);
      const freshest = c.segments.reduce((a, s) =>
        ageMs(s.updated_at) < ageMs(a.updated_at) ? s : a
      );
      return `<a class="card card-link" href="#/c/${c.id}">
        <div class="corridor-head">
          <div><span class="corridor-name">${esc(c.name)}</span>${c.code ? `<span class="corridor-code">${esc(c.code)}</span>` : ""}</div>
          ${chip(v.status, { updated_at: freshest.updated_at })}
        </div>
        <div class="corridor-route">${esc(c.from)} → ${esc(c.to)}${c.via ? " via " + esc(c.via) : ""}</div>
        ${v.decider && v.status !== "OPEN" ? `<div class="decider">⚠️ ${esc(v.decider.name)} — ${(STATUS_META[v.status] || STATUS_META.UNKNOWN).label.toLowerCase()}</div>` : ""}
        <div class="meta">Updated ${esc(ageLabel(freshest.updated_at))} · ${c.segments.length} segments</div>
      </a>`;
    })
    .join("");
  return `${feedBanner()}<h2>Road status — all corridors</h2>${cards}
    <p class="note">Statuses older than 24 hours are shown grey as <b>possibly outdated</b>, never green. Tap a corridor for segment-by-segment detail.</p>`;
}

function viewTrip() {
  const opts = DATA.places
    .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
    .join("");
  return `${feedBanner()}<h2>🧭 Check your trip</h2>
  <div class="card">
    <label for="from">From</label>
    <select id="from">${opts}</select>
    <label for="to">To</label>
    <select id="to">${opts}</select>
    <button class="primary" id="check">Check road</button>
  </div>
  <div id="trip-result"></div>`;
}

function verdictForCorridors(ids) {
  let worst = "OPEN",
    decider = null,
    deciderCorridor = null;
  ids.forEach((id) => {
    const c = corridorById(id);
    if (!c) return;
    const v = corridorVerdict(c);
    if (SEVERITY[v.status] > SEVERITY[worst]) {
      worst = v.status;
      decider = v.decider;
      deciderCorridor = c;
    }
  });
  return { status: worst, decider, deciderCorridor };
}

function renderTripResult(from, to) {
  const box = document.getElementById("trip-result");
  if (from === to) {
    box.innerHTML = `<div class="alert">Pick two different places.</div>`;
    return;
  }
  const trip = DATA.trips.find((t) => t.from === from && t.to === to);
  if (!trip) {
    box.innerHTML = `<div class="alert">No tracked route for ${esc(placeName(from))} → ${esc(placeName(to))} in v1. Try the corridor list on Home.</div>`;
    return;
  }
  box.innerHTML = `<h3>${esc(placeName(from))} → ${esc(placeName(to))}</h3>` +
    trip.options
      .map((o) => {
        const v = verdictForCorridors(o.corridors);
        const names = o.corridors
          .map((id) => { const c = corridorById(id); return c ? c.name : id; })
          .join(" + ");
        const dots = o.corridors
          .map((id) => {
            const c = corridorById(id);
            if (!c) return "";
            return c.segments.map((s) => `<span class="seg-dot seg-dot-${displayStatus(s)}" title="${esc(s.name)}"></span>`).join("");
          })
          .join("");
        return `<div class="trip-opt">
          <div class="verdict"><span class="opt-label">${esc(o.label)}</span>${chip(v.status, v.decider || { updated_at: new Date().toISOString() })}</div>
          <div class="small">${esc(names)}</div>
          <div class="seg-strip">${dots}</div>
          ${v.decider ? `<div class="decider">⚠️ Deciding segment: <b>${esc(v.decider.name)}</b>${v.deciderCorridor ? " (" + esc(v.deciderCorridor.name) + ")" : ""}<br>${esc(v.decider.note || "")}</div>` : `<div class="decider">✅ All segments open on this option.</div>`}
          ${o.note ? `<div class="opt-note">${esc(o.note)}</div>` : ""}
        </div>`;
      })
      .join("");
}

function viewCorridor(id) {
  const c = corridorById(id);
  if (!c) return `<div class="center">Corridor not found. <a href="#/">Back home</a></div>`;
  const v = corridorVerdict(c);
  const segs = c.segments
    .map((s) => {
      const ds = displayStatus(s);
      const meta = STATUS_META[ds];
      return `<div class="seg">
        <div class="seg-top"><span class="seg-name">${esc(s.name)}</span>${chip(s.status, s)}</div>
        ${s.cause ? `<div class="seg-note"><b>Cause:</b> ${esc(s.cause)}</div>` : ""}
        ${s.note ? `<div class="seg-note">${esc(s.note)}</div>` : ""}
        ${s.vehicle_limit ? `<span class="vlimit">🚧 ${esc(s.vehicle_limit)}</span>` : ""}
        <div class="meta">Updated ${esc(ageLabel(s.updated_at))}${isStale(s.updated_at) ? " — <b>possibly outdated</b>" : ""}</div>
        ${s.source_name ? `<div class="source">Source: ${s.source_url ? `<a href="${esc(s.source_url)}" target="_blank" rel="noopener">${esc(s.source_name)}</a>` : esc(s.source_name)} <span class="small">(${esc(s.confidence || "unverified")})</span></div>` : ""}
      </div>`;
    })
    .join("");
  return `${feedBanner()}
  <p><a href="#/">← All corridors</a></p>
  <div class="card">
    <div class="corridor-head">
      <div><span class="corridor-name">${esc(c.name)}</span>${c.code ? `<span class="corridor-code">${esc(c.code)}</span>` : ""}</div>
      ${chip(v.status, v.decider || { updated_at: new Date().toISOString() })}
    </div>
    <div class="corridor-route">${esc(c.from)} → ${esc(c.to)}${c.via ? " via " + esc(c.via) : ""}</div>
  </div>
  <h3>Segments</h3>
  <div class="card">${segs}</div>`;
}

function viewAbout() {
  return `<h2>About ${esc(APP_NAME)}</h2>
  <div class="card">
    <p><b>${esc(APP_NAME)}</b> answers one question: <i>is the road open?</i> — for Nepal's highways, segment by segment, with the reason, when it was last confirmed, and the source.</p>
    <p style="margin-top:8px">A highway is never just "closed". A <b>segment</b> is — one bridge, one landslide-prone bend. The corridor verdict is decided by its worst segment, and you always see which one.</p>
  </div>
  <h3>Data sources</h3>
  <div class="card"><ul class="clean">
    <li>🟢 <b>DoR NAVIGATE</b> (navigate.dor.gov.np) — official per-section closures, live feed</li>
    <li>🚔 <b>Nepal Traffic Police</b> — holds, releases, one-way rulings</li>
    <li>📰 <b>News</b> (Rising Nepal Daily, OnlineKhabar, Khabarhub…) — backup for events the official feed lags on</li>
    <li>🌧️ <b>DHM</b> weather — risk context only, never shown as a closure</li>
  </ul></div>
  <h3>Trust rules</h3>
  <div class="card"><ul class="clean">
    <li>Every status shows its source and confirmed-at time.</li>
    <li>Data older than 24 hours is shown grey as <b>possibly outdated</b> — never a confident green.</li>
    <li>Official sources outrank media; reopenings need the same evidence as closures.</li>
    <li>v1 seed data is from 2026-10-05/07 news reports — always check the source link before travelling.</li>
  </ul></div>
  <p class="small">Version ${esc(APP_VERSION)}. Installable: open in your phone browser → Add to Home Screen.</p>`;
}

/* ---------- router ---------- */

function render() {
  const view = document.getElementById("view");
  const hash = location.hash || "#/";
  document.querySelectorAll(".tabbar a").forEach((a) => {
    const tab = a.getAttribute("data-tab");
    a.classList.toggle(
      "active",
      (tab === "home" && (hash === "#/" || hash.startsWith("#/c/"))) ||
        (tab === "trip" && hash.startsWith("#/trip")) ||
        (tab === "about" && hash.startsWith("#/about"))
    );
  });
  if (hash.startsWith("#/c/")) {
    view.innerHTML = viewCorridor(hash.slice(4));
  } else if (hash.startsWith("#/trip")) {
    view.innerHTML = viewTrip();
    const from = document.getElementById("from");
    const to = document.getElementById("to");
    from.value = "kathmandu";
    to.value = "narayanghat";
    document.getElementById("check").addEventListener("click", () =>
      renderTripResult(from.value, to.value)
    );
    renderTripResult(from.value, to.value);
  } else if (hash.startsWith("#/about")) {
    view.innerHTML = viewAbout();
  } else {
    view.innerHTML = viewHome();
  }
  window.scrollTo(0, 0);
}

/* ---------- boot ---------- */

function updateOnlineUI() {
  const b = document.getElementById("offline-banner");
  b.hidden = navigator.onLine !== false;
  const age = document.getElementById("data-age");
  if (DATA) {
    const newest = DATA.corridors
      .flatMap((c) => c.segments)
      .reduce((a, s) => (ageMs(s.updated_at) < ageMs(a.updated_at) ? s : a));
    age.textContent = "data: " + ageLabel(newest.updated_at);
  }
}

async function boot() {
  document.getElementById("app-name").textContent = APP_NAME;
  document.getElementById("app-version").textContent = APP_VERSION;
  document.title = APP_NAME + " — Nepal road status";
  const view = document.getElementById("view");
  view.innerHTML = `<div class="center"><div class="spinner">🛣️</div><p>Loading road data…</p></div>`;
  try {
    await loadData();
  } catch (e) {
    view.innerHTML = `<div class="center"><p>⚠️ Could not load road data.</p><p class="small">${esc(e.message)}</p><p><a href="#/" onclick="location.reload()">Retry</a></p></div>`;
    return;
  }
  window.addEventListener("hashchange", render);
  window.addEventListener("online", updateOnlineUI);
  window.addEventListener("offline", updateOnlineUI);
  render();
  updateOnlineUI();
  setInterval(updateOnlineUI, 60000);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", boot);
