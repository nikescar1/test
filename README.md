# MINI Cooper S — Deal-O-Meter (Cloudflare Pages)

Hosted tool that pulls **current MINI Cooper S listings with mileage** and grades any asking price
against the market (price-vs-mileage regression). A Cloudflare Pages Function fetches the data
**server-side** (no CORS), so the browser just renders it.

```
index.html                  the tool (static)
functions/api/inventory.js  Pages Function -> GET /api/inventory
wrangler.toml               Pages config
```

## Data sources (primary + automatic fallback)

1. **MINI's own public GraphQL API** (free, no key) — the same endpoint miniusa.com's search uses.
   Its `getInventory` query returns a per-vehicle `mileage` field.
   `POST https://www.miniusa.com/bin/services/gateway.inventory.json/v1/inventory-search-service/graphql`
2. **Auto.dev listings API** (needs a key) — used **automatically** only if MINI errors or returns
   zero cars. This is the reliability backstop.

The page falls back to a built-in snapshot + drag-in-a-saved-page if both are unavailable, so it
never shows a blank screen.

## Deploy

1. Push this folder to a GitHub repo.
2. Cloudflare -> Workers & Pages -> Create -> Pages -> Connect to Git -> pick repo.
   Framework: None | Build command: (empty) | Output dir: /
3. Deploy. MINI works with **zero config**.
4. (Optional, enables fallback) Settings -> Environment variables -> add
   `AUTODEV_API_KEY = <your key>` as a **Secret**, then redeploy.

CLI alternative: `npm i -g wrangler && wrangler pages deploy .`
Set the secret via: `wrangler pages secret put AUTODEV_API_KEY`

> SECURITY: the key you pasted in chat should be rotated in the Auto.dev dashboard. Only ever store
> the new key as a Cloudflare Secret — never commit it to the repo.

## Test each source (after deploy)

- `/api/inventory?debug=1`          — shows which source answered + a raw sample (and each attempt)
- `/api/inventory?source=mini`      — force MINI only
- `/api/inventory?source=autodev`   — force Auto.dev only
- `/api/inventory?all=1`            — include all trims/models (not just Cooper S 2-door)
- `/api/inventory?year=2024&zip=90210&range=500`

### Test MINI reliability right now (from your machine)
```bash
curl -s -X POST 'https://www.miniusa.com/bin/services/gateway.inventory.json/v1/inventory-search-service/graphql' \
  -H 'content-type: application/json' -H 'accept: application/json' \
  --data '{"query":"query{ getInventory(brand:MI, zip:\"66952\", bucket:BYO, filter:{locatorRange:3000, excludeStopSale:true, sold:false, used:true, minPrice:0, minModelYear:2025}, sorting:[{order:ASC,criteria:PRICE}], pagination:{pageIndex:1,pageSize:5}){ numberOfFilteredVehicles totalPages result{ name modelYear internetPrice mileage vin exteriorColorDescription } } }"}'
```
If that returns JSON with `result[].mileage`, the free MINI path is reliable and will be used. If it's
blocked or empty, the Function auto-uses Auto.dev.

## Troubleshoot

- **MINI GraphQL error mentioning `minModelYear`:** remove that one field from `miniQuery()` in
  `functions/api/inventory.js`; the year post-filter still applies.
- **Wrong fields / 0 cars:** run `?debug=1`, look at `sample`, and adjust the field names in
  `miniNorm()` / `adNorm()` or the `FILTER` lists.
- **Auto.dev HTTP 401/403:** key wrong or plan lacks `/listings`; the VIN endpoint you tested is a
  different route. Check your Auto.dev plan.

## Notes

- Personal-use tool; results are edge-cached 15 min to keep both sources light.
- Grading uses the price-vs-mileage regression once 3+ cars have mileage — with live data, that's
  from the first load.
