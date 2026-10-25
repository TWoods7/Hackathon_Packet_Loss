// Build the browser-facing outage grid used by the map's outage masks.
// Run from the project root after the database scripts have built data/extracted/:
//   npm run data:grid
// Output: public/data/grid.json (no premise IDs or raw source IDs).

// Import Node's built-in asynchronous file functions.
import { readFile, writeFile } from "node:fs/promises";

// Read and parse a JSON file.
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Load the teammate database outputs, customers, and labor reference.
const upstream = await readJson("data/extracted/upstream-by-premise.json");
const transformers = await readJson("data/extracted/transformers.geojson");
const fuses = await readJson("data/extracted/fuses.geojson");
const reclosers = await readJson("data/extracted/reclosers.geojson");
const switches = await readJson("data/extracted/switches.geojson");
const poles = await readJson("data/extracted/poles.geojson");
const primary = await readJson("data/extracted/primary-lines.geojson");
const secondary = await readJson("data/extracted/secondary-lines.geojson");
const damage = await readJson("data/extracted/damage.geojson");
const crosswalk = await readJson("data/extracted/recloser-crosswalk.json");
const customers = await readJson("public/data/customers.json");
const labor = await readJson("public/data/labor.json");

// Normalize lookup values while preserving identifiers as text.
const key = (value) => String(value ?? "").trim();

// Combine source table and device ID into an unambiguous identity.
const deviceKey = (sourceTable, deviceId) =>
  JSON.stringify([key(sourceTable), key(deviceId)]);

// Round coordinates to ~1 m to keep the browser file small.
const round = (n, digits = 5) => Math.round(n * 10 ** digits) / 10 ** digits;

// Device types the browser shows, keyed by the upstream deviceType text.
const DEVICE_TYPES = {
  Distribution: "Transformer",
  Fuse: "Fuse",
  "Recloser (Hydraulic)": "Recloser",
  "Recloser (Electronic)": "Recloser",
  Sectionalizer: "Sectionalizer",
  Step: "Step transformer",
  "Circuit Breaker": "Circuit breaker",
};

// Devices that open (cut power downstream) when there's a fault behind them.
const PROTECTIVE = new Set(["Fuse", "Recloser", "Sectionalizer", "Circuit breaker"]);

// ---------------------------------------------------------------------------
// Distance helpers and a grid index for nearest-feature lookups.
// ---------------------------------------------------------------------------

// Approximate meters between two [lng, lat] points (fine at neighborhood scale).
function meters(a, b) {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * k * 111320, (b[1] - a[1]) * 110540);
}

// Meters from point p to the segment a-b.
function segmentMeters(p, a, b) {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * k * 111320, ay = (a[1] - p[1]) * 110540;
  const bx = (b[0] - p[0]) * k * 111320, by = (b[1] - p[1]) * 110540;
  const dx = bx - ax, dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// Index features in ~200 m cells so lookups only check nearby features.
function gridIndex(features, cell = 0.002) {
  const cells = new Map();
  const cellKey = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;

  for (const feature of features) {
    const g = feature.geometry;
    if (!g) continue;
    const coords = g.type === "Point" ? [g.coordinates] : g.coordinates;
    const seen = new Set();
    for (const [x, y] of coords) {
      const k = cellKey(x, y);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(feature);
    }
  }

  // Return the nearest feature to p and its distance in meters.
  return function nearest(p, maxRings = 5) {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
    let best = null, bestDistance = Infinity;
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let x = cx - ring; x <= cx + ring; x++) {
        for (let y = cy - ring; y <= cy + ring; y++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue;
          for (const feature of cells.get(`${x},${y}`) ?? []) {
            const g = feature.geometry;
            let d;
            if (g.type === "Point") d = meters(p, g.coordinates);
            else {
              d = Infinity;
              for (let i = 0; i + 1 < g.coordinates.length; i++) {
                d = Math.min(d, segmentMeters(p, g.coordinates[i], g.coordinates[i + 1]));
              }
            }
            if (d < bestDistance) { bestDistance = d; best = feature; }
          }
        }
      }
      // Anything in a farther ring is at least this far away.
      if (best && bestDistance < ring * cell * 90000) break;
    }
    return { feature: best, distance: bestDistance };
  };
}

// ---------------------------------------------------------------------------
// 1. Devices from the upstream chains.
// ---------------------------------------------------------------------------

// Index GIS features for coordinates and circuits.
const transformerById = new Map(transformers.features.map((f) => [key(f.properties.id), f]));
const fuseById = new Map(fuses.features.map((f) => [key(f.properties.id), f]));
const recloserByAssembly = new Map(reclosers.features.map((f) => [key(f.properties.id), f]));

// Map each upstream recloser identity to its GIS assembly (location/type crosswalk).
const recloserAssemblyByDevice = new Map();
for (const record of crosswalk.records) {
  const candidate = record.candidates?.[0];
  if (candidate) {
    recloserAssemblyByDevice.set(
      deviceKey(record.upstream.sourceTable, record.upstream.deviceId),
      key(candidate.assemblyId),
    );
  }
}

// One entry per unique device; index = position in the devices array.
const devices = [];
const deviceIndex = new Map();
// First protective device above each transformer (from any premise chain).
const firstProtective = new Map();

// Add a device the first time we see it and return its index.
function addDevice(hop) {
  const k = deviceKey(hop.sourceTable, hop.deviceId);
  if (deviceIndex.has(k)) return deviceIndex.get(k);

  const type = DEVICE_TYPES[hop.deviceType] ?? hop.deviceType;
  let feature = null;
  if (type === "Transformer") feature = transformerById.get(key(hop.deviceId));
  else if (type === "Fuse") feature = fuseById.get(key(hop.deviceId));
  else if (type === "Recloser") feature = recloserByAssembly.get(recloserAssemblyByDevice.get(k));

  const index = devices.length;
  devices.push({
    key: k,
    type,
    location: key(hop.location),
    coords: feature?.geometry?.coordinates ?? null,
    circuit: feature?.properties.aep_circui ?? null,
    customers: 0,
  });
  deviceIndex.set(k, index);
  return index;
}

// ---------------------------------------------------------------------------
// 2. Customer -> device chain, aligned with customers.json rows.
// ---------------------------------------------------------------------------

const premiseColumn = customers.fields.indexOf("premise");
let customersWithoutChain = 0;

const customerChains = customers.rows.map((row) => {
  const chain = upstream.byPremise[key(row[premiseColumn])];
  if (!chain) {
    customersWithoutChain++;
    return [];
  }

  const indices = chain.map(addDevice);
  for (const i of indices) devices[i].customers++;

  // Remember each transformer's first protective device.
  const transformer = indices[0];
  if (!firstProtective.has(transformer)) {
    const protective = indices.slice(1).find((i) => PROTECTIVE.has(devices[i].type));
    firstProtective.set(transformer, protective ?? null);
  }
  return indices;
});

// Circuit breakers have no GIS record; give them their customers' circuit name.
for (const chain of customerChains) {
  const transformer = devices[chain[0]];
  for (const i of chain) {
    if (!devices[i].circuit && transformer?.circuit) devices[i].circuit = transformer.circuit;
  }
}

// Transformers by location, for joining GIS points and lines back to the network.
const transformerDevicesByLocation = new Map();
for (const [i, d] of devices.entries()) {
  if (d.type !== "Transformer") continue;
  if (!transformerDevicesByLocation.has(d.location)) transformerDevicesByLocation.set(d.location, []);
  transformerDevicesByLocation.get(d.location).push(i);
}

// ---------------------------------------------------------------------------
// 3. Protection zones along the primary lines.
// ---------------------------------------------------------------------------

// Graph nodes are "circuit|location" so separate circuits never merge.
const node = (circuit, location) => `${circuit}|${location}`;
const nodesAtLocation = new Map();
const neighbors = new Map();

// Record a graph node and remember which circuits use each location.
function addNode(circuit, location) {
  const n = node(circuit, location);
  if (!neighbors.has(n)) {
    neighbors.set(n, []);
    if (!nodesAtLocation.has(location)) nodesAtLocation.set(location, []);
    nodesAtLocation.get(location).push(n);
  }
  return n;
}

for (const feature of primary.features) {
  const { location_n: a, location_1: b, aep_circui: circuit } = feature.properties;
  if (!a || !b) continue;
  const na = addNode(circuit, key(a));
  const nb = addNode(circuit, key(b));
  neighbors.get(na).push(nb);
  neighbors.get(nb).push(na);
}

// Zones stop at protective devices and at normally-open switches or fuses.
const stopLocations = new Set();
for (const d of devices) {
  if (PROTECTIVE.has(d.type) && d.type !== "Circuit breaker") stopLocations.add(d.location);
}
for (const feature of [...switches.features, ...fuses.features]) {
  if (feature.properties.normal_sta === "Open") stopLocations.add(key(feature.properties.location_n));
}
const isStop = (n) => stopLocations.has(n.slice(n.indexOf("|") + 1));

// Flood-fill the graph into zones without crossing stop locations.
const zoneOfNode = new Map();
const zones = [];
for (const start of neighbors.keys()) {
  if (zoneOfNode.has(start) || isStop(start)) continue;
  const zone = { nodes: [start], device: null };
  zoneOfNode.set(start, zones.length);
  for (let i = 0; i < zone.nodes.length; i++) {
    for (const next of neighbors.get(zone.nodes[i])) {
      if (zoneOfNode.has(next) || isStop(next)) continue;
      zoneOfNode.set(next, zones.length);
      zone.nodes.push(next);
    }
  }
  zones.push(zone);
}

// The device protecting a set of graph nodes: among the protective devices
// feeding transformers there, the most upstream one (it feeds the most customers).
function protectingDevice(graphNodes) {
  let best = null;
  for (const n of graphNodes) {
    const location = n.slice(n.indexOf("|") + 1);
    for (const t of transformerDevicesByLocation.get(location) ?? []) {
      const p = firstProtective.get(t);
      if (p != null && (best === null || devices[p].customers > devices[best].customers)) best = p;
    }
  }
  return best;
}

for (const zone of zones) zone.device = protectingDevice(zone.nodes);

// A stop location sits between zones; damage there trips the upstream one.
function deviceForNode(n) {
  if (!isStop(n)) return zones[zoneOfNode.get(n)]?.device ?? null;
  const adjacent = neighbors.get(n).filter((m) => !isStop(m)).map((m) => zones[zoneOfNode.get(m)]?.device);
  const candidates = [...adjacent, protectingDevice([n])].filter((d) => d != null);
  return candidates.reduce((best, d) => (best === null || devices[d].customers > devices[best].customers ? d : best), null);
}

// Device tripped by damage at a location, preferring the damage's own circuit.
function deviceForLocation(location, circuit) {
  const nodes = nodesAtLocation.get(location) ?? [];
  const ordered = [...nodes.filter((n) => n.startsWith(`${circuit}|`)), ...nodes];
  for (const n of ordered) {
    const d = deviceForNode(n);
    if (d != null) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Nearest-feature indexes for matching damage and poles to the network.
// ---------------------------------------------------------------------------

const nearestTransformer = gridIndex(transformers.features);
const nearestFuse = gridIndex(fuses.features);
const nearestRecloser = gridIndex(reclosers.features);
const nearestSwitch = gridIndex(switches.features);
const nearestPole = gridIndex(poles.features);
const nearestPrimary = gridIndex(primary.features);
const nearestSecondary = gridIndex(secondary.features);

// Network device for the transformer nearest to a point (within maxMeters).
function nearestTransformerDevice(point, maxMeters = 150) {
  const { feature, distance } = nearestTransformer(point);
  if (!feature || distance > maxMeters) return null;
  return deviceIndex.get(deviceKey(feature.properties.eo_source_, feature.properties.id)) ?? null;
}

// ---------------------------------------------------------------------------
// 4. Failure candidates (poles) with a historical failure weight.
// ---------------------------------------------------------------------------

// Pole and primary-wire damage per circuit, over all years, sets each circuit's risk.
const lineDamageByCircuit = new Map();
for (const f of damage.features) {
  const p = f.properties;
  if (p.Asset_Type === "Pole" || p.Asset_Type === "primary") {
    lineDamageByCircuit.set(p.Circuit, (lineDamageByCircuit.get(p.Circuit) ?? 0) + 1);
  }
}

const candidateRows = [];
const polesByCircuit = new Map();
let polesOffNetwork = 0;

for (const feature of poles.features) {
  const location = key(feature.properties.location_n);
  const point = feature.geometry.coordinates;
  const nodes = nodesAtLocation.get(location) ?? [];
  let device = null;
  let circuit = null;
  let onPrimary = false;

  for (const n of nodes) {
    device = deviceForNode(n);
    if (device != null) {
      circuit = n.slice(0, n.indexOf("|"));
      onPrimary = true;
      break;
    }
  }

  // Poles that only carry service wire feed the nearest transformer's customers.
  if (device == null) {
    device = nearestTransformerDevice(point);
    circuit = device != null ? devices[device].circuit : null;
  }
  if (device == null) {
    polesOffNetwork++;
    continue;
  }

  polesByCircuit.set(circuit, (polesByCircuit.get(circuit) ?? 0) + 1);
  candidateRows.push({ point, device, circuit, onPrimary, pole: feature.properties });
}

// ---------------------------------------------------------------------------
// Storm calibration: how much line damage the worst storm in the data caused.
// ---------------------------------------------------------------------------

// Group busy report days (10+ reports, gaps of up to 2 days) into storms.
const reportsPerDay = new Map();
for (const f of damage.features) {
  const reported = f.properties.Report_Tim;
  if (reported) reportsPerDay.set(reported, (reportsPerDay.get(reported) ?? 0) + 1);
}
const storms = [];
for (const reported of [...reportsPerDay.keys()].filter((d) => reportsPerDay.get(d) >= 10).sort()) {
  const last = storms.at(-1);
  if (last && (new Date(reported) - new Date(last.end)) / 86400000 <= 2) last.end = reported;
  else storms.push({ start: reported, end: reported });
}

// 100% storm severity = the line damage (poles and wires) of the biggest storm.
const LINE_DAMAGE = new Set(["Pole", "primary", "secondary"]);
const stormLineDamage = (storm) =>
  damage.features.filter((f) => {
    const p = f.properties;
    return LINE_DAMAGE.has(p.Asset_Type) && p.Report_Tim >= storm.start && p.Report_Tim <= storm.end;
  }).length;
const worstStorm = storms.reduce((a, b) => (stormLineDamage(b) > stormLineDamage(a) ? b : a));
const worstStormLineDamage = stormLineDamage(worstStorm);

// ---------------------------------------------------------------------------
// 5. Current damage: unrepaired reports, matched to the device they trip.
// ---------------------------------------------------------------------------

// Count phases from a phase string like "ABC" or "B".
const phaseCount = (phases) => Math.max(1, key(phases).replace(/[^ABC]/g, "").length);

// Direct labor hours for one damage using the recipe for its asset type.
function directHours(p, asset) {
  const recipe = labor.recipes[p.Asset_Type];
  if (!recipe) return null;

  const hoursFor = (cu, mode) =>
    mode === "install" ? cu.install : mode === "remove" ? cu.remove : cu.install + cu.remove;

  let hours = 0;
  for (const [part, quantity, mode] of recipe) {
    let cu = labor.cu[part];
    let count = quantity === "perPhase" ? phaseCount(asset?.existing_p) : quantity;

    if (part === "pole") {
      const feet = Number.parseFloat(asset?.height ?? "") || 40;
      cu = labor.poleBySize.find((size) => feet <= size.maxFeet);
    } else if (part === "transformer" || part === "transformer833") {
      const specs = [asset?.a_phase_sp, asset?.b_phase_sp, asset?.c_phase_sp].filter(Boolean);
      const kva = part === "transformer833" ? 833 : Number.parseFloat(specs[0] ?? "") || 25;
      cu = labor.transformerByKva.reduce((a, b) => (Math.abs(b.kva - kva) < Math.abs(a.kva - kva) ? b : a));
      if (part === "transformer") count = specs.length || 1;
    }
    hours += hoursFor(cu, mode) * count;
  }

  // Add workbook adders for access problems and special equipment.
  const equipment = p.Special_Eq;
  if (p.Access_Iss === "Yes") hours += labor.adders.restrictedAccess.hours;
  if (equipment === "Backyard Bucket" || equipment === "Yard Dog") hours += labor.adders.confinedProperty.hours;
  else if (equipment === "Track Hoe" || equipment === "Backhoe") hours += labor.adders.remoteSite.hours;
  else if (equipment) hours += labor.adders.specializedHandling.hours;

  return Math.round(hours * 1000) / 1000;
}

// Find the asset a damage report sits on and the device that loses power.
function traceDamage(p, point) {
  const type = p.Asset_Type;

  if (type === "Transformer") {
    const { feature } = nearestTransformer(point);
    return { asset: feature, device: nearestTransformerDevice(point), method: "device" };
  }
  if (type === "Fuse Bank") {
    const { feature } = nearestFuse(point);
    const device = deviceIndex.get(deviceKey(feature.properties.eo_source_, feature.properties.id));
    return { asset: feature, device: device ?? null, method: "device" };
  }
  if (type === "Recloser Bank") {
    const { feature } = nearestRecloser(point);
    const assembly = key(feature.properties.id);
    const match = [...recloserAssemblyByDevice].find(([, a]) => a === assembly);
    return { asset: feature, device: match ? deviceIndex.get(match[0]) : null, method: "device" };
  }
  if (type === "secondary") {
    // Secondary wire only affects the transformer it hangs from.
    const { feature } = nearestSecondary(point);
    return { asset: feature, device: nearestTransformerDevice(point), method: "secondary" };
  }
  // Lights don't feed customers; capacitor banks have their own fuse, so a
  // failure blows that fuse without cutting anyone's power.
  if (type === "Light" || type === "Capacitor Bank") {
    return { asset: null, device: null, method: "none" };
  }

  // Pole, primary wire, switch, step transformer: use the protection zone.
  let asset;
  let locations;
  if (type === "primary") {
    asset = nearestPrimary(point).feature;
    locations = [asset.properties.location_n, asset.properties.location_1];
  } else if (type === "Switch") {
    asset = nearestSwitch(point).feature;
    locations = [asset.properties.location_n];
  } else {
    asset = nearestPole(point).feature;
    locations = [asset.properties.location_n];
  }

  for (const location of locations.filter(Boolean).map(key)) {
    const device = deviceForLocation(location, p.Circuit);
    if (device != null) return { asset, device, method: "line-trace" };
  }

  // Fallback (low confidence): the nearest transformer, or what protects it.
  const transformer = nearestTransformerDevice(point);
  if (transformer == null) return { asset, device: null, method: "untraced" };
  const device = type === "Pole" ? transformer : firstProtective.get(transformer) ?? transformer;
  return { asset, device, method: "nearest-transformer" };
}

const damageRows = [];
const methodCounts = {};

for (const f of damage.features) {
  const p = f.properties;
  if (p.Repaired !== "No") continue;

  const point = [p.Longitude, p.Latitude];
  const { asset, device, method } = traceDamage(p, point);
  methodCounts[method] = (methodCounts[method] ?? 0) + 1;

  damageRows.push([
    round(point[0]),
    round(point[1]),
    p.Asset_Type ?? "Unknown",
    p.Inform_Wor ?? null,
    p.Circuit ?? null,
    p.Report_Tim ?? null,
    device,
    directHours(p, asset?.properties),
    method,
  ]);
}

// ---------------------------------------------------------------------------
// Failure candidates for the storm forecast (needs directHours above).
// ---------------------------------------------------------------------------

// Weight = circuit's historical line-damage rate per pole; service poles count half.
// Repair hours: a pole on the primary lines gets the pole recipe (sized by height);
// a service-only pole gets the secondary-wire recipe.
const candidates = candidateRows.map(({ point, device, circuit, onPrimary, pole }) => {
  const rate = (lineDamageByCircuit.get(circuit) ?? 0) / (polesByCircuit.get(circuit) ?? 1);
  const weight = (rate + 0.0005) * (onPrimary ? 1 : 0.5);
  const hours = directHours({ Asset_Type: onPrimary ? "Pole" : "secondary" }, pole);
  return [round(point[0]), round(point[1]), device, round(weight, 6), hours];
});

// ---------------------------------------------------------------------------
// Write the browser file.
// ---------------------------------------------------------------------------

const output = {
  meta: {
    schemaVersion: 1,
    description:
      "Outage grid for the map. A customer has no power when any device in its chain is tripped. " +
      "Current damage is the unrepaired reports, treated as today's outages (simulation, not live data).",
    customerChains: "Aligned with customers.json rows: device indices from the customer's transformer up to the substation breaker. Empty = no upstream data.",
    candidates: "Poles that can fail in a simulated storm: the device they trip, a relative failure weight from historical damage on their circuit, and direct repair hours from labor.json.",
    traceMethod: "device = the damaged asset is the device; line-trace = protection zone along primary lines; secondary = transformer feeding the wire; nearest-transformer = low-confidence fallback; untraced = couldn't be matched; none = no customer impact (lights, capacitor banks).",
    indirectLaborMultiplier: labor.indirectLaborMultiplier,
    // 100% storm severity in the map = this many broken poles and wires.
    worstStorm: { ...worstStorm, lineDamage: worstStormLineDamage },
  },
  devices: {
    fields: ["type", "lng", "lat", "circuit", "customers"],
    rows: devices.map((d) => [
      d.type,
      d.coords ? round(d.coords[0]) : null,
      d.coords ? round(d.coords[1]) : null,
      d.circuit,
      d.customers,
    ]),
  },
  customerChains,
  candidates: { fields: ["lng", "lat", "device", "weight", "directHours"], rows: candidates },
  damages: {
    fields: ["lng", "lat", "assetType", "damageType", "circuit", "reported", "device", "directHours", "traceMethod"],
    rows: damageRows,
  },
};

const outputPath = "public/data/grid.json";
const text = JSON.stringify(output) + "\n";
await writeFile(outputPath, text);

// Print the counts that matter for checking the result.
const tripped = new Set(damageRows.map((r) => r[6]).filter((d) => d != null));
const noPower = customerChains.filter((chain) => chain.some((i) => tripped.has(i))).length;

console.table({
  devices: devices.length,
  customers: customerChains.length,
  customersWithoutChain,
  protectionZones: zones.length,
  zonesWithoutDevice: zones.filter((z) => z.device == null).length,
  failureCandidates: candidates.length,
  worstStorm: `${worstStorm.start} to ${worstStorm.end}`,
  worstStormLineDamage,
  polesOffNetwork,
  currentDamages: damageRows.length,
  trippedDevices: tripped.size,
  customersWithoutPower: noPower,
  fileMegabytes: Math.round(text.length / 1e5) / 10,
});
console.table(methodCounts);
console.log(`Saved outage grid to ${outputPath}`);
