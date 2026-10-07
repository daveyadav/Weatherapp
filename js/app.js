/* Bato Update — Nepal road status PWA (v2)
 * Single rename point for the app name: APP_NAME below (+ manifest.json,
 * sw.js cache name is versioned separately).
 *
 * v2: full national coverage (79 NH refs + Pharping alternative, from the
 * authoritative DoR NAVIGATE road list), journey-timeline trip view, and a
 * route graph so From -> To works across multiple corridors.
 */
const APP_NAME = "Bato Update";
const APP_VERSION = "v3 • 2026-10-07";

const STATUS_META = {
  OPEN:    { label: "Open",    np: "खुला",    cls: "open" },
  ONE_WAY: { label: "One-way", np: "एकतर्फी", cls: "one_way" },
  PARTIAL: { label: "Partial", np: "आंशिक",   cls: "partial" },
  CLOSED:  { label: "Closed",  np: "बन्द",    cls: "closed" },
  UNKNOWN: { label: "Unknown", np: "अज्ञात",   cls: "unknown" },
};
/* Worst-first order for deriving a corridor verdict from its segments. */
const SEVERITY = { CLOSED: 4, UNKNOWN: 3, PARTIAL: 2, ONE_WAY: 1, OPEN: 0 };
/* Freshness: older than STALE_MS => "possibly outdated", never green. */
const STALE_MS = 24 * 3600 * 1000;

let DATA = null;   // corridors.json content (after NAVIGATE merge)
let FEED = { ok: false, live: false, fetchedAt: null, count: 0 };
let GRAPH = null;  // place -> [{place, corridor}]
let HOME_FILTER = "all";
let HOME_QUERY = "";

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

/* Compact age for the hero stat ("2h", "45m", "3d"). */
function shortAge(iso) {
  const ms = ageMs(iso);
  if (!isFinite(ms)) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

/* A stale status is displayed as UNKNOWN-grey ("possibly outdated") — never green. */
function displayStatus(seg) {
  return isStale(seg.updated_at) ? "UNKNOWN" : seg.status;
}

function chip(status, extra) {
  const st = displayStatus({ status, updated_at: extra && extra.updated_at });
  const meta = STATUS_META[st] || STATUS_META.UNKNOWN;
  const staleNote =
    extra && isStale(extra.updated_at) ? " · possibly outdated" : "";
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
function freshestSeg(c) {
  return c.segments.reduce((a, s) =>
    ageMs(s.updated_at) < ageMs(a.updated_at) ? s : a
  );
}

/* ---------- data loading ---------- */

async function loadData() {
  const res = await fetch("data/corridors.json", { cache: "no-store" });
  if (!res.ok) throw new Error("corridors.json not found");
  const raw = await res.json();
  let corridors = raw.corridors;
  try {
    const nav = await getNavigateRecords();
    const merged = mergeNavigateIntoCorridors(corridors, nav);
    corridors = merged.corridors;
    FEED = merged.feed;
  } catch (e) {
    FEED = { ok: false, live: false, fetchedAt: null, count: 0 };
  }
  DATA = { ...raw, corridors };
  GRAPH = buildGraph(corridors);
}

function feedBanner() {
  if (FEED.ok && FEED.live) {
    const when = FEED.fetchedAt ? ageLabel(FEED.fetchedAt) : "just now";
    return `<div class="alert feed-ok">🟢 Live DoR feed · ${FEED.count} closure records · fetched ${esc(when)}</div>`;
  }
  if (FEED.fetchedAt) {
    return `<div class="alert">🟠 Live feed unreachable — showing last-known data (fetched ${esc(ageLabel(FEED.fetchedAt))})</div>`;
  }
  return `<div class="alert">🟠 Live DoR feed unreachable — showing seed data. Check source links before you travel.</div>`;
}

/* ---------- route graph ---------- */
/* Each corridor is a chain: from_place -> via_places... -> to_place.
 * Edges are bidirectional; BFS finds multi-corridor trips. */
function buildGraph(corridors) {
  const g = {};
  const add = (a, b, corridor) => {
    if (!a || !b || a === b) return;
    (g[a] = g[a] || []).push({ place: b, corridor });
    (g[b] = g[b] || []).push({ place: a, corridor });
  };
  corridors.forEach((c) => {
    const chain = [c.from_place, ...(c.via_places || []), c.to_place];
    for (let i = 0; i + 1 < chain.length; i++) add(chain[i], chain[i + 1], c.id);
  });
  return g;
}

/* BFS, up to 3 distinct shortest paths, max `maxLegs` corridors.
 * A corridor may continue through several places (legs collapse consecutive
 * duplicates); places are never revisited, so there are no cycles. */
function findPaths(fromId, toId, maxLegs) {
  maxLegs = maxLegs || 4;
  const paths = [];
  const seenPaths = new Set();
  const seenState = new Set();
  const queue = [{ place: fromId, legs: [], visited: new Set([fromId]) }];
  while (queue.length && paths.length < 3) {
    const cur = queue.shift();
    if (cur.place === toId && cur.legs.length > 0) {
      const key = cur.legs.join(">");
      if (!seenPaths.has(key)) {
        seenPaths.add(key);
        paths.push(cur.legs.slice());
      }
      continue;
    }
    (GRAPH[cur.place] || []).forEach((e) => {
      if (cur.visited.has(e.place)) return; // no cycles
      const legs = cur.legs.slice();
      if (legs[legs.length - 1] !== e.corridor) legs.push(e.corridor);
      if (legs.length > maxLegs) return;
      const skey = e.place + "|" + legs.join(">");
      if (seenState.has(skey)) return;
      seenState.add(skey);
      queue.push({
        place: e.place,
        legs,
        visited: new Set([...cur.visited, e.place]),
      });
    });
  }
  return paths;
}

/* ---------- shared render pieces ---------- */

/* One journey-timeline node: what the traveler faces at this segment. */
function timelineNode(seg, corridor) {
  const ds = displayStatus(seg);
  const tn = corridor.travel_notes || {};
  let expect = seg.expect || "";
  const liveBits = [];
  if (seg.note) liveBits.push(esc(seg.note));
  if (seg.vehicle_limit) liveBits.push("🚧 " + esc(seg.vehicle_limit));
  return `<div class="tnode st-${ds.toLowerCase()}">
    <div class="tnode-head">
      <div><div class="tnode-name">${esc(seg.name)}</div>
      <div class="tnode-corridor">${corridor.ref ? esc(corridor.ref) + " · " : ""}${esc(corridor.name)}</div></div>
      ${chip(seg.status, seg)}
    </div>
    ${expect ? `<div class="tnode-expect"><span class="lbl">What to expect</span>${esc(expect)}</div>` : ""}
    ${liveBits.length ? `<div class="tnode-live">${liveBits.join("<br>")}</div>` : ""}
    ${tn.night_rules ? `<div class="tnode-meta">🌙 ${esc(tn.night_rules)}</div>` : ""}
    <div class="tnode-meta">Updated ${esc(ageLabel(seg.updated_at))}${isStale(seg.updated_at) ? " — <b>possibly outdated</b>" : ""} · ${esc(seg.source_name || "")}</div>
  </div>`;
}

function corridorLegLabel(corridor) {
  return `<div class="tleg">continues on <b>${corridor.ref ? esc(corridor.ref) + " · " : ""}${esc(corridor.name)}</b></div>`;
}

function tripTimelineHTML(legs) {
  let html = '<div class="timeline">';
  let prevCorridor = null;
  legs.forEach((cid) => {
    const c = corridorById(cid);
    if (!c) return;
    if (prevCorridor && prevCorridor !== cid) html += corridorLegLabel(c);
    prevCorridor = cid;
    c.segments.forEach((s) => {
      html += timelineNode(s, c);
    });
  });
  return html + "</div>";
}

function verdictForLegs(legs) {
  let worst = "OPEN",
    decider = null,
    deciderCorridor = null;
  legs.forEach((cid) => {
    const c = corridorById(cid);
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

/* ---------- views ---------- */

function filteredCorridors() {
  const q = HOME_QUERY.trim().toLowerCase();
  return DATA.corridors
    .filter((c) => {
      const v = corridorVerdict(c);
      if (HOME_FILTER === "alerts" && v.status === "OPEN") return false;
      if (HOME_FILTER === "open" && v.status !== "OPEN") return false;
      if (!q) return true;
      const hay = [c.name, c.ref, c.from, c.to, c.via, c.name_np]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => {
      const sa = SEVERITY[corridorVerdict(a).status];
      const sb = SEVERITY[corridorVerdict(b).status];
      return sb - sa || a.name.localeCompare(b.name);
    });
}

function homeListHTML() {
  const list = filteredCorridors();
  const cards = list
    .map((c) => {
      const v = corridorVerdict(c);
      const f = freshestSeg(c);
      return `<a class="card card-link st-${v.status.toLowerCase()}" href="#/c/${c.id}">
        <div class="corridor-head">
          <div><span class="corridor-name">${esc(c.name)}</span>${c.ref ? `<span class="corridor-code">${esc(c.ref)}</span>` : ""}</div>
          ${chip(v.status, { updated_at: f.updated_at })}
        </div>
        <div class="corridor-route">${esc(c.from)} → ${esc(c.to)}${c.via ? " via " + esc(c.via) : ""}</div>
        ${v.decider && v.status !== "OPEN" ? `<div class="decider">⚠️ ${esc(v.decider.name)} — ${(STATUS_META[v.status] || STATUS_META.UNKNOWN).label.toLowerCase()}</div>` : ""}
        <div class="meta">Updated ${esc(ageLabel(f.updated_at))} · ${c.segments.length} segment${c.segments.length === 1 ? "" : "s"}</div>
      </a>`;
    })
    .join("");
  return `<p class="count-line">${list.length} of ${DATA.corridors.length} highways · worst-affected first</p>
  ${cards || `<div class="card"><p class="note">No highways match “${esc(HOME_QUERY)}”.</p></div>`}`;
}

function viewHome() {
  let openCount = 0,
    alertCount = 0;
  DATA.corridors.forEach((c) => {
    if (corridorVerdict(c).status === "OPEN") openCount++;
    else alertCount++;
  });
  const newest = DATA.corridors
    .flatMap((c) => c.segments)
    .reduce((a, s) => (ageMs(s.updated_at) < ageMs(a.updated_at) ? s : a));
  return `${feedBanner()}
  <section class="hero">
    <div class="hero-kicker">🇳🇵 Live · DoR feed</div>
    <h2>Is the road open?</h2>
    <p class="hero-sub">Every national highway of Nepal — segment by segment, with what you'll actually face on the way.</p>
    <div class="hero-stats">
      <div class="hstat"><b>${openCount}</b><span>Open</span></div>
      <div class="hstat hstat-warn"><b>${alertCount}</b><span>With alerts</span></div>
      <div class="hstat"><b>${esc(shortAge(newest.updated_at))}</b><span>Data age</span></div>
    </div>
    <div class="hero-road" aria-hidden="true"></div>
  </section>
  <input id="q" class="searchbar" type="search" placeholder="Search highway, code (NH17), or place…" value="${esc(HOME_QUERY)}" aria-label="Search corridors" autocomplete="off">
  <div class="fchips">
    <button class="fchip${HOME_FILTER === "all" ? " active" : ""}" data-f="all">All</button>
    <button class="fchip${HOME_FILTER === "alerts" ? " active" : ""}" data-f="alerts">⚠️ With alerts (${alertCount})</button>
    <button class="fchip${HOME_FILTER === "open" ? " active" : ""}" data-f="open">✅ Open now</button>
  </div>
  <div id="home-list">${homeListHTML()}</div>
  <p class="note">Statuses older than 24 hours are shown grey as <b>possibly outdated</b>, never green. Tap a highway for segment detail and travel notes.</p>`;
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

function renderTripResult(from, to) {
  const box = document.getElementById("trip-result");
  if (from === to) {
    box.innerHTML = `<div class="alert">Pick two different places.</div>`;
    return;
  }
  const paths = findPaths(from, to);
  if (!paths.length) {
    box.innerHTML = `<div class="alert">No connected route found for ${esc(placeName(from))} → ${esc(placeName(to))} on the tracked highway network. Try nearby towns.</div>`;
    return;
  }
  box.innerHTML =
    `<h3>${esc(placeName(from))} → ${esc(placeName(to))}</h3>` +
    paths
      .map((legs, i) => {
        const v = verdictForLegs(legs);
        const names = legs
          .map((cid) => {
            const c = corridorById(cid);
            return c ? (c.ref ? c.ref + " " : "") + c.name : cid;
          })
          .join(" → ");
        const segCount = legs.reduce(
          (n, cid) => n + ((corridorById(cid) || { segments: [] }).segments.length),
          0
        );
        const dots = legs
          .flatMap((cid) => ((corridorById(cid) || {}).segments || []))
          .map(
            (s) =>
              `<span class="seg-dot seg-dot-${displayStatus(s)}" title="${esc(s.name)}"></span>`
          )
          .join("");
        return `<div class="card trip-opt st-${v.status.toLowerCase()}">
          <div class="verdict">
            <span class="opt-badge">${i + 1}</span>
            <div class="verdict-main">
              <div class="opt-label">Option ${i + 1}</div>
              <div class="small">${esc(names)} · ${segCount} segments</div>
            </div>
            ${chip(v.status, v.decider || { updated_at: new Date().toISOString() })}
          </div>
          <div class="seg-strip" aria-hidden="true">${dots}</div>
          ${v.decider ? `<div class="decider">⚠️ Watch out: <b>${esc(v.decider.name)}</b>${v.deciderCorridor ? " (" + esc(v.deciderCorridor.name) + ")" : ""}</div>` : `<div class="decider decider-ok">✅ No reported problems on this option.</div>`}
          <h3>Journey timeline</h3>
          ${tripTimelineHTML(legs)}
        </div>`;
      })
      .join("");
}

function travelNotesHTML(c) {
  const tn = c.travel_notes || {};
  if (!tn.verified) {
    return `<div class="card"><h3 style="margin-top:0">🧳 What to expect</h3>
      <p class="unverified-note">${esc(tn.note || "Not yet researched in detail — live status comes from the DoR feed. Check with local traffic police before travelling.")}</p></div>`;
  }
  const row = (lbl, val) =>
    val ? `<dt>${lbl}</dt><dd>${esc(val)}</dd>` : "";
  const hazards =
    tn.hazards && tn.hazards.length
      ? `<dt>Known hazards</dt><dd><ul>${tn.hazards.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></dd>`
      : "";
  const src =
    tn.sources && tn.sources.length
      ? `<div class="source">Research sources: ${tn.sources.map((s) => (s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name))).join(" · ")}</div>`
      : "";
  return `<div class="card"><h3 style="margin-top:0">🧳 What to expect on this road</h3>
    <dl class="tnotes">
      ${row("Road surface", tn.surface)}
      ${row("Typical time", tn.typical_time)}
      ${row("Monsoon behaviour", tn.monsoon_risk)}
      ${row("Night rules", tn.night_rules)}
      ${row("Vehicle limits", tn.vehicle_limits)}
      ${hazards}
    </dl>${src}</div>`;
}

function liveRecordsHTML(c) {
  const recs = (c._liveRecords || []).filter((r) => r.status !== "OPEN");
  const opened = (c._liveRecords || []).filter((r) => r.status === "OPEN");
  if (!recs.length && !opened.length) {
    return `<div class="card"><h3 style="margin-top:0">📡 Live DoR records</h3>
      <p class="note">No closure records on the live DoR feed for this highway${FEED.fetchedAt ? " (fetched " + esc(ageLabel(FEED.fetchedAt)) + ")" : ""}.</p></div>`;
  }
  const item = (r) => `<div class="lrec">
      <div class="lr-head"><span class="lr-name">${esc(r.road_name || r.location || r.link_code)}</span>${chip(r.status, { updated_at: FEED.fetchedAt })}</div>
      ${r.reason ? `<div>Reason: ${esc(r.reason)}</div>` : ""}
      ${r.location ? `<div class="small">📍 ${esc(r.location)}${r.chainage ? " · chainage " + esc(r.chainage) : ""}</div>` : ""}
      ${r.repair_eta ? `<div class="small">⏱️ Repair ETA: ${esc(r.repair_eta)}</div>` : ""}
      ${r.efforts ? `<div class="small">Efforts: ${esc(r.efforts)}</div>` : ""}
      ${r.closed_since ? `<div class="small">Blocked since: ${esc(r.closed_since)}</div>` : ""}
      <div class="source">DoR NAVIGATE · <a href="https://navigate.dor.gov.np" target="_blank" rel="noopener">navigate.dor.gov.np</a></div>
    </div>`;
  return `<div class="card"><h3 style="margin-top:0">📡 Live DoR records</h3>
    ${recs.map(item).join("")}
    ${opened.length ? `<h3>Cleared</h3>${opened.map(item).join("")}` : ""}</div>`;
}

function viewCorridor(id) {
  const c = corridorById(id);
  if (!c)
    return `<div class="center">Highway not found. <a href="#/">Back home</a></div>`;
  const v = corridorVerdict(c);
  const f = freshestSeg(c);
  const segs = c.segments
    .map((s) => {
      const ds = displayStatus(s);
      return `<div class="seg">
        <div class="seg-top"><span class="seg-name">${esc(s.name)}</span>${chip(s.status, s)}</div>
        ${s.expect && s.expect !== "Status comes from the live DoR feed for this highway." ? `<div class="seg-note">${esc(s.expect)}</div>` : ""}
        ${s.cause ? `<div class="seg-note"><b>Cause:</b> ${esc(s.cause)}</div>` : ""}
        ${s.note ? `<div class="seg-note">${esc(s.note)}</div>` : ""}
        ${s.vehicle_limit ? `<span class="vlimit">🚧 ${esc(s.vehicle_limit)}</span>` : ""}
        <div class="meta">Updated ${esc(ageLabel(s.updated_at))}${isStale(s.updated_at) ? " — <b>possibly outdated</b>" : ""}</div>
        ${s.source_name ? `<div class="source">Source: ${s.source_url ? `<a href="${esc(s.source_url)}" target="_blank" rel="noopener">${esc(s.source_name)}</a>` : esc(s.source_name)} <span class="small">(${esc(s.confidence || "unverified")})</span></div>` : ""}
      </div>`;
    })
    .join("");
  return `${feedBanner()}
  <p><a href="#/">← All highways</a></p>
  <div class="card detail-head st-${v.status.toLowerCase()}">
    <div class="corridor-head">
      <div><span class="corridor-name">${esc(c.name)}</span>${c.ref ? `<span class="corridor-code">${esc(c.ref)}</span>` : ""}${c.name_np ? `<div class="small">${esc(c.name_np)}</div>` : ""}</div>
      ${chip(v.status, { updated_at: f.updated_at })}
    </div>
    <div class="corridor-route">${esc(c.from)} → ${esc(c.to)}${c.via ? " via " + esc(c.via) : ""}</div>
  </div>
  ${travelNotesHTML(c)}
  <h3>Segments</h3>
  <div class="card">${segs}</div>
  ${liveRecordsHTML(c)}`;
}

function viewAbout() {
  return `<h2>About ${esc(APP_NAME)}</h2>
  <div class="card">
    <p><b>${esc(APP_NAME)}</b> answers one question: <i>is the road open?</i> — for every national highway of Nepal (NH01–NH80), segment by segment, with what you will actually face on the way: the reason, when it was last confirmed, and the source.</p>
    <p style="margin-top:8px">A highway is never just "closed". A <b>segment</b> is — one bridge, one landslide-prone bend. The highway verdict is decided by its worst segment, and you always see which one. The <b>journey timeline</b> on the Trip tab lays out the whole trip as a story, not a dot.</p>
  </div>
  <h3>Data sources</h3>
  <div class="card"><ul class="clean">
    <li>🟢 <b>DoR NAVIGATE</b> (navigate.dor.gov.np) — official per-section closures, live feed every 15 min</li>
    <li>🚔 <b>Nepal Traffic Police</b> — holds, releases, one-way rulings</li>
    <li>📰 <b>News</b> (Rising Nepal Daily, OnlineKhabar, Khabarhub, The Himalayan Times, Ratopati…) — backup for events the official feed lags on</li>
    <li>🧳 <b>Travel notes</b> — researched per corridor (landslide chokepoints, night rules, vehicle limits); unresearched roads say so openly</li>
  </ul></div>
  <h3>Trust rules</h3>
  <div class="card"><ul class="clean">
    <li>Every status shows its source and confirmed-at time.</li>
    <li>Data older than 24 hours is shown grey as <b>possibly outdated</b> — never a confident green.</li>
    <li>Official sources outrank media; reopenings need the same evidence as closures.</li>
    <li>Always check the source link before travelling — mountain weather changes fast.</li>
  </ul></div>
  <p class="small">Version ${esc(APP_VERSION)}. ${DATA.corridors.length} highways · ${DATA.places.length} places. Installable: open in your phone browser → Add to Home Screen.</p>`;
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
    const q = document.getElementById("q");
    q.addEventListener("input", () => {
      HOME_QUERY = q.value;
      const list = document.getElementById("home-list");
      if (list) list.innerHTML = homeListHTML();
    });
    document.querySelectorAll(".fchip").forEach((b) =>
      b.addEventListener("click", () => {
        HOME_FILTER = b.getAttribute("data-f");
        render();
      })
    );
  }
  window.scrollTo(0, 0);
}

/* ---------- boot ---------- */

function updateOnlineUI() {
  const b = document.getElementById("offline-banner");
  if (b) b.hidden = navigator.onLine !== false;
  const age = document.getElementById("data-age");
  if (DATA && age) {
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
  view.innerHTML = `<div aria-hidden="true"><div class="skel skel-hero"></div><div class="skel skel-line"></div><div class="skel skel-card"></div><div class="skel skel-card"></div></div><p class="center small">Loading road data…</p>`;
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
