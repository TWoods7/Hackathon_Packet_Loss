// Converts the AEP Customer_Clip shapefile into a compact JSON file for the map.
//
// Get the source data first (from the repo root):
//   git clone https://github.com/hackohio/aep_challenge_hack26.git ../aep_challenge_hack26
//   mkdir -p data/extracted/Data1
//   unzip -n ../aep_challenge_hack26/data/raw/Data1.zip 'Customer_Clip.*' -d data/extracted/Data1
//
// Then: npm run data:customers [path/to/Customer_Clip]
import { writeFile } from "node:fs/promises";
import { open } from "shapefile";

const base = process.argv[2] ?? "data/extracted/Data1/Customer_Clip";
const outPath = "public/data/customers.json";

// Overhead / Underground / Unknown service
const KIND = { Overhead: 0, Underground: 1 };

const source = await open(`${base}.shp`, `${base}.dbf`);
const rows = [];

for (let r = await source.read(); !r.done; r = await source.read()) {
  const { geometry, properties: p } = r.value;
  if (!geometry) continue;
  const [lng, lat] = geometry.coordinates;
  rows.push([
    +lng.toFixed(6),
    +lat.toFixed(6),
    KIND[p.kind_of_se] ?? 2,
    p.critical_c === "LS Life Support" ? 1 : 0,
    p.customer_c,
    p.circuit_id,
    p.aep_xfmr_l,
    [p.road_name, p.city, p.state].filter(Boolean).join(", "),
    p.premise_nu,
  ]);
}

const fields = ["lng", "lat", "kind", "lifeSupport", "customerCount", "circuitId", "transformer", "location", "premise"];
await writeFile(outPath, JSON.stringify({ fields, rows }));
console.log(`Wrote ${rows.length} customers to ${outPath}`);
