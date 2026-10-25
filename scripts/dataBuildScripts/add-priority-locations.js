// Mark grid devices that serve a priority location (hospital, fire station,
// ambulance station), so restoration can put those repairs first.
// Run from the project root after build-outage-grid.js (npm run data:grid runs both).
//
// Each facility is matched to the nearest customer point with network data; every
// device on that point's line is marked. Only a per-device count goes into
// public/data/grid.json: no facility names or coordinates reach the browser.

// Import Node's built-in asynchronous file functions.
import { readFile, writeFile } from "node:fs/promises";

// Facilities farther than this from any customer point are outside the service area.
const MAX_MATCH_METERS = 300;

// Public facility layers: the hospital export and the exported USGS station layers.
const SOURCES = [
  "public/data/hospitals.geojson",
  "data/extracted/fire-stations.geojson",
  "data/extracted/ambulance-stations.geojson",
];

// Read and parse a JSON file.
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Distance in meters between two [lng, lat] points.
function distanceMeters([lng1, lat1], [lng2, lat2]) {
  const toRad = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * toRad) / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(((lng2 - lng1) * toRad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const gridPath = "public/data/grid.json";
const grid = await readJson(gridPath);
const customers = await readJson("data/extracted/customers.json");
const lngColumn = customers.fields.indexOf("lng");
const latColumn = customers.fields.indexOf("lat");

// Customer points that the network traces to devices.
const linked = customers.rows
  .map((row, index) => ({ point: [row[lngColumn], row[latColumn]], index }))
  .filter(({ index }) => grid.customerChains[index].length > 0);

const priority = new Array(grid.devices.rows.length).fill(0);
let facilities = 0;
let matched = 0;
for (const source of SOURCES) {
  for (const feature of (await readJson(source)).features) {
    facilities++;
    const point = feature.geometry.coordinates.slice(0, 2);
    let nearest = null;
    let best = Infinity;
    for (const customer of linked) {
      const d = distanceMeters(point, customer.point);
      if (d < best) {
        best = d;
        nearest = customer;
      }
    }
    if (best > MAX_MATCH_METERS) continue;
    matched++;
    for (const device of grid.customerChains[nearest.index]) priority[device]++;
  }
}

// Replace any earlier priority column, then append the new one.
const fields = grid.devices.fields.filter((f) => f !== "priority");
const keep = fields.map((f) => grid.devices.fields.indexOf(f));
grid.devices = {
  fields: [...fields, "priority"],
  rows: grid.devices.rows.map((row, i) => [...keep.map((k) => row[k]), priority[i]]),
};
grid.meta.priorityLocations = {
  description: "devices.priority = how many priority locations (hospitals, fire and ambulance stations) the device's repair restores. Matched to the nearest customer point within maxMatchMeters.",
  facilities,
  matched,
  maxMatchMeters: MAX_MATCH_METERS,
};

await writeFile(gridPath, JSON.stringify(grid) + "\n");
console.table({ facilities, matched, devicesMarked: priority.filter((n) => n > 0).length });
console.log(`Saved priority flags to ${gridPath}`);
