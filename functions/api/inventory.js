// Cloudflare Pages Function  ->  GET /api/inventory
//
// Primary source: MINI's own public inventory GraphQL API (free, no key). Same data the
// miniusa.com search uses; its getInventory query returns per-vehicle `mileage`.
// Fallback source: Auto.dev listings API (needs AUTODEV_API_KEY) — used automatically if
// MINI returns an error or zero cars. So you get the free source when it works and a
// reliable paid-tier backstop when it doesn't.
//
// SETUP:
//   - Nothing required for MINI.
//   - Optional (enables fallback): Cloudflare Pages -> Settings -> Environment variables ->
//       AUTODEV_API_KEY = <your Auto.dev key>   (store as a Secret; never commit it)
//
// TEST / DEBUG (after deploy):
//   /api/inventory?debug=1            -> shows which source answered + a raw sample of each try
//   /api/inventory?source=mini        -> force MINI only
//   /api/inventory?source=autodev     -> force Auto.dev only
//   /api/inventory?all=1              -> don't restrict to Cooper S 2-door
//   /api/inventory?year=2024&zip=90210&range=500

const MINI = {
  endpoint: "https://www.miniusa.com/bin/services/gateway.inventory.json/v1/inventory-search-service/graphql",
  zip: "66952", range: 3000, minYear: 2025, pageSize: 96, maxPages: 6,
};
const AUTODEV = {
  base: "https://api.auto.dev/listings", make: "MINI", minYear: 2025,
  minPrice: 15000, maxPrice: 60000, maxMiles: 60000, maxPages: 5, scanCap: 500,
};
const FILTER = {
  bodyIncludes: ["2 door", "2-door", "hardtop"],
  bodyExcludes: ["convertible", "countryman", "clubman", "aceman", "4 door", "4-door"],
  trimIncludes: ["cooper s"],
};
const CACHE_SECS = 900;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";
  const force = url.searchParams.get("source");           // "mini" | "autodev"
  const all = url.searchParams.get("all") === "1";
  const minYear = int(url.searchParams.get("year")) ?? MINI.minYear;
  const zip = url.searchParams.get("zip") || MINI.zip;
  const range = int(url.searchParams.get("range")) ?? MINI.range;

  const attempts = [];

  if (force !== "autodev") {
    const r = await tryMini({ zip, range, minYear, all });
    attempts.push({ source: "miniusa", ok: r.ok, count: r.cars.length, hint: r.hint });
    if (r.ok && r.cars.length) return done("miniusa.com graphql", r, attempts, debug);
    if (debug) attempts[attempts.length - 1].sample = r.sample;
  }

  if (force !== "mini" && env && env.AUTODEV_API_KEY) {
    const r = await tryAutodev({ key: env.AUTODEV_API_KEY, minYear, all });
    attempts.push({ source: "auto.dev", ok: r.ok, count: r.cars.length, hint: r.hint });
    if (r.ok && r.cars.length) return done("auto.dev", r, attempts, debug);
    if (debug) attempts[attempts.length - 1].sample = r.sample;
  }

  return json({ ok: false, hint: "no source returned cars", attempts }, 200);
}

function done(source, r, attempts, debug) {
  if (debug) return json({ ok: true, chosen: source, attempts, sample: r.sample }, 200);
  return json({ ok: true, source, count: r.cars.length, cars: r.cars }, 200, CACHE_SECS);
}

/* ---------- MINI GraphQL ---------- */
function miniQuery(zip, range, minYear, page, size) {
  return `query inventory { getInventory(
      brand: MI, zip: "${zip}", bucket: BYO,
      filter: { locatorRange: ${range}, excludeStopSale: true, sold: false, used: true, minPrice: 0, minModelYear: ${minYear} },
      sorting: [{order: ASC, criteria: PRICE}],
      pagination: { pageIndex: ${page}, pageSize: ${size} }
    ) { totalPages result {
      name modelYear vehicleDetailsPage qualifiedModelCode agCode
      engineDriveType { name } modelRange { code name }
      totalMsrp internetPrice dealerLocation dealerId vin
      usedCarType exteriorColorDescription mileage } } }`;
}
async function tryMini({ zip, range, minYear, all }) {
  let results = [], totalPages = 1, sample = null;
  try {
    for (let p = 1; p <= MINI.maxPages; p++) {
      const res = await fetch(MINI.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json",
          "origin": "https://www.miniusa.com", "referer": "https://www.miniusa.com/used-inventory.html",
          "user-agent": "Mozilla/5.0 (compatible; deal-o-meter/1.0)" },
        body: JSON.stringify({ query: miniQuery(zip, range, minYear, p, MINI.pageSize) }),
      });
      if (!res.ok) return { ok: false, cars: [], hint: `MINI HTTP ${res.status}`, sample: (await res.text()).slice(0, 300) };
      const j = await res.json();
      if (j.errors) return { ok: false, cars: [], hint: "MINI GraphQL error", sample: JSON.stringify(j.errors).slice(0, 400) };
      const inv = j && j.data && j.data.getInventory;
      const rs = (inv && inv.result) || [];
      if (!sample && rs.length) sample = rs[0];
      results = results.concat(rs);
      totalPages = (inv && inv.totalPages) || 1;
      if (p >= totalPages) break;
    }
  } catch (e) { return { ok: false, cars: [], hint: "MINI fetch failed: " + (e.message || e) }; }
  const cars = results.map(miniNorm).filter(c => c && c.price > 0)
    .filter(c => !c.year || c.year >= minYear)
    .filter(c => matchAny(c._body, FILTER.bodyIncludes) && !matchAny(c._body, FILTER.bodyExcludes))
    .filter(c => all ? true : matchAny(c._trim, FILTER.trimIncludes)).map(strip);
  return { ok: true, cars: dedupe(cars), sample };
}
function miniNorm(r) {
  if (!r) return null;
  const year = num(r.modelYear), mr = r.modelRange || {}, name = r.name || "";
  let link = r.vehicleDetailsPage || ""; if (link && link.startsWith("/")) link = "https://www.miniusa.com" + link;
  const miles = num(r.mileage);
  return { price: num(r.internetPrice) || num(r.totalMsrp), miles: miles > 0 ? miles : null,
    year: year || 0, color: r.exteriorColorDescription || "", title: [year, "MINI", mr.name || name].filter(Boolean).join(" "),
    dealer: r.dealerLocation || r.dealerId || "", dist: "", link, vin: (r.vin || "").toUpperCase(),
    _body: `${mr.name || ""} ${mr.code || ""} ${name}`.toLowerCase(),
    _trim: `${name} ${r.qualifiedModelCode || ""} ${r.agCode || ""} ${(r.engineDriveType || {}).name || ""}`.toLowerCase() };
}

/* ---------- Auto.dev fallback ---------- */
async function tryAutodev({ key, minYear, all }) {
  let allRows = [], sample = null;
  try {
    for (let page = 1; page <= AUTODEV.maxPages; page++) {
      const qs = new URLSearchParams({ "vehicle.make": AUTODEV.make, limit: "100", page: String(page) });
      const res = await fetch(`${AUTODEV.base}?${qs}`, { headers: { accept: "application/json", Authorization: `Bearer ${key}` } });
      if (!res.ok) return { ok: false, cars: [], hint: `Auto.dev HTTP ${res.status}`, sample: (await res.text()).slice(0, 300) };
      const data = await res.json();
      const listings = Array.isArray(data) ? data : (data.data || data.listings || data.records || []);
      if (!sample && listings.length) sample = listings[0];
      allRows = allRows.concat(listings);
      if (listings.length < 100 || allRows.length >= AUTODEV.scanCap) break;
    }
  } catch (e) { return { ok: false, cars: [], hint: "Auto.dev fetch failed: " + (e.message || e) }; }
  const cars = allRows.map(adNorm).filter(c => c && c.price > 0)
    .filter(c => !c.year || c.year >= minYear)
    .filter(c => c.price >= AUTODEV.minPrice && c.price <= AUTODEV.maxPrice)
    .filter(c => !c.miles || c.miles <= AUTODEV.maxMiles)
    .filter(c => matchAny(c._body, FILTER.bodyIncludes) && !matchAny(c._body, FILTER.bodyExcludes))
    .filter(c => all ? true : matchAny(c._trim, FILTER.trimIncludes)).map(strip);
  return { ok: true, cars: dedupe(cars), sample };
}
function adNorm(l) {
  if (!l || typeof l !== "object") return null;
  const v = l.vehicle || l;
  const year = num(pick(v, ["year", "modelYear"]) ?? pick(l, ["year"]));
  const model = pick(v, ["model", "modelName"]) || "", trim = pick(v, ["trim", "trimName", "series"]) || "";
  const body = pick(v, ["bodyType", "body", "bodyStyle"]) || "";
  const miles = num(pick(l, ["mileage", "miles", "odometer"]) ?? pick(v, ["mileage", "miles", "odometer"]));
  let link = pick(l, ["vdpUrl", "clickoffUrl", "url", "detailUrl"]) || (l.links && l.links.self) || "";
  if (link && link.startsWith("/")) link = "https://auto.dev" + link;
  const vin = String(pick(v, ["vin"]) || pick(l, ["vin"]) || "").toUpperCase();
  if (!link && vin) link = `https://www.google.com/search?q=${vin}`;
  return { price: num(pick(l, ["price", "priceUnformatted", "retailPrice", "listPrice"])),
    miles: miles > 0 ? miles : null, year: year || 0,
    color: pick(v, ["exteriorColor", "color", "exteriorColorName"]) || "",
    title: [year, "MINI", model].filter(Boolean).join(" "),
    dealer: pick(l, ["dealerName"]) || pick(l.dealer || {}, ["name"]) || "", dist: "", link, vin,
    _body: `${model} ${body}`.toLowerCase(), _trim: `${trim} ${model}`.toLowerCase() };
}

/* ---------- shared ---------- */
function strip(c) { const { _body, _trim, year, ...rest } = c; return rest; }
function dedupe(arr) { const s = new Set(), o = []; for (const c of arr) { const k = c.vin || `${c.price}|${c.dealer}`; if (!s.has(k)) { s.add(k); o.push(c); } } return o; }
function matchAny(s, a) { s = (s || "").toLowerCase(); return a.some(x => s.includes(x)); }
function pick(o, ks) { for (const k of ks) { if (o && o[k] != null && o[k] !== "") return o[k]; } return undefined; }
function num(x) { if (x == null) return null; const n = parseInt(String(x).split(".")[0].replace(/[^\d]/g, ""), 10); return isNaN(n) ? null : n; }
function int(x) { const n = parseInt(x, 10); return isNaN(n) ? null : n; }
function json(obj, status = 200, cacheSecs = 0) {
  return new Response(JSON.stringify(obj), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": cacheSecs ? `public, max-age=${cacheSecs}` : "no-store" } });
}
