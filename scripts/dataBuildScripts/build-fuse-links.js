// Join upstream fuse references with GIS fuse records and customer circuits.
// Run from the project root. These outputs remain internal working data.

// Import Node's built-in asynchronous file functions.
import { readFile, writeFile } from "node:fs/promises";

// Read and parse a JSON file.
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Load the three datasets needed for this join.
const upstream = await readJson("data/extracted/upstream-by-premise.json");
const fuses = await readJson("data/extracted/fuses.geojson");
const customers = await readJson("public/data/customers.json");

// Require the expected generated-data and GeoJSON structures.
if (
  upstream.schemaVersion !== 1 ||
  !upstream.byPremise ||
  fuses.type !== "FeatureCollection" ||
  !Array.isArray(fuses.features)
) {
  throw new Error("Unexpected upstream or fuse input structure.");
}

// Normalize lookup values while preserving identifiers as text.
const key = (value) => String(value ?? "").trim();

// Combine source table and device ID into an unambiguous identity.
const deviceKey = (sourceTable, deviceId) =>
  JSON.stringify([key(sourceTable), key(deviceId)]);

// Resolve customer columns by name.
const columns = Object.fromEntries(
  customers.fields.map((name, index) => [name, index]),
);

// Require the customer fields used for circuit checks.
for (const name of ["premise", "circuitId"]) {
  if (columns[name] === undefined) {
    throw new Error(`Customer data is missing field: ${name}`);
  }
}

// Index customer circuits, preserving absent-customer versus blank-circuit cases.
const customerCircuits = new Map();

for (const row of customers.rows) {
  const premise = key(row[columns.premise]);
  const circuitId = key(row[columns.circuitId]);

  // Reject duplicate or blank customer identifiers.
  if (!premise || customerCircuits.has(premise)) {
    throw new Error(`Blank or duplicate customer premise: ${premise}`);
  }

  customerCircuits.set(premise, circuitId);
}

// Index GIS fuses by source-table/device-ID identity.
// Arrays retain multiple candidates if a future export contains duplicates.
const gisByIdentity = new Map();

for (const feature of fuses.features) {
  // Keep only the attributes needed for relationship checks.
  // Geometry remains in fuses.geojson instead of being repeated in every link.
  const p = feature.properties;
  const candidate = {
    sourceTable: key(p?.eo_source_),
    deviceId: key(p?.id),
    location: key(p?.location_n),
    deviceType: key(p?.device_typ),
    circuitId: key(p?.circuit_id),
  };

  // Stop if required GIS attributes are absent.
  if (Object.values(candidate).some((value) => value === "")) {
    throw new Error("A GIS fuse has an incomplete reference.");
  }

  // Add this GIS record to its identity's candidate group.
  const identity = deviceKey(candidate.sourceTable, candidate.deviceId);
  const candidates = gisByIdentity.get(identity) ?? [];
  candidates.push(candidate);
  gisByIdentity.set(identity, candidates);
}

// Track distinct upstream identities separately from repeated references.
const seenDevices = new Set();
const uniqueGISDevices = new Set();
const missingGISDevices = new Set();
const ambiguousGISDevices = new Set();

// Count mutually exclusive outcomes for individual fuse references.
const summary = {
  references: 0,
  consistent: 0,
  source_conflict: 0,
  missing_gis: 0,
  ambiguous_gis: 0,
  missing_customer: 0,
  missing_customer_circuit: 0,
};

// Retain all links by premise and exceptions in a separate collection.
const byPremise = new Map();
const exceptions = [];

// Iterate upstream premises so references without customer records remain visible.
for (const [premise, chain] of Object.entries(upstream.byPremise)) {
  const links = [];

  for (const equipment of chain) {
    // Process only fuse equipment during this checkpoint.
    if (equipment.deviceType !== "Fuse") continue;

    // Locate GIS candidates using the original upstream identity.
    const identity = deviceKey(equipment.sourceTable, equipment.deviceId);
    const candidates = gisByIdentity.get(identity) ?? [];
    seenDevices.add(identity);

    // Preserve absent customer context as null.
    const customerPresent = customerCircuits.has(premise);
    const customerCircuit = customerPresent
      ? customerCircuits.get(premise)
      : null;

    // Initialize unavailable comparisons separately from disagreements.
    const checks = {
      upstreamVsGISLocation: null,
      upstreamVsGISType: null,
      customerVsGISCircuit: null,
    };

    let status;

    // Classify identity matching before comparing individual GIS fields.
    if (candidates.length === 0) {
      missingGISDevices.add(identity);
      status = "missing_gis";
    } else if (candidates.length > 1) {
      ambiguousGISDevices.add(identity);
      status = "ambiguous_gis";
    } else {
      // A unique GIS identity permits location and equipment-type comparisons.
      uniqueGISDevices.add(identity);
      const gis = candidates[0];

      checks.upstreamVsGISLocation =
        key(equipment.location) === gis.location;

      checks.upstreamVsGISType =
        key(equipment.deviceType) === gis.deviceType;

      // Customer availability determines whether a circuit comparison is possible.
      if (!customerPresent) {
        status = "missing_customer";
      } else if (!customerCircuit) {
        status = "missing_customer_circuit";
      } else {
        checks.customerVsGISCircuit =
          customerCircuit === gis.circuitId;

        // Only explicit false values indicate observed disagreements.
        const hasConflict = Object.values(checks).some(
          (value) => value === false,
        );

        status = hasConflict ? "source_conflict" : "consistent";
      }
    }

    // Preserve the source reference, GIS candidates, context, and comparisons.
    const link = {
      premise,
      hop: equipment.hop,
      upstream: {
        sourceTable: key(equipment.sourceTable),
        deviceId: key(equipment.deviceId),
        location: key(equipment.location),
        deviceType: key(equipment.deviceType),
      },
      gisCandidates: candidates,
      customerPresent,
      customerCircuit,
      checks,
      status,
    };

    // Count and retain every fuse reference.
    summary.references++;
    summary[status]++;
    links.push(link);

    // Keep unresolved or conflicting references in the exception report.
    if (status !== "consistent") {
      exceptions.push(link);
    }
  }

  // Only premises containing fuse references need entries in this dataset.
  if (links.length > 0) {
    byPremise.set(premise, links);
  }
}

// Summarize distinct devices separately from reference-level outcomes.
const deviceSummary = {
  gisFuses: fuses.features.length,
  upstreamDevices: seenDevices.size,
  uniqueGISDevices: uniqueGISDevices.size,
  missingGISDevices: missingGISDevices.size,
  ambiguousGISDevices: ambiguousGISDevices.size,
};

// Include an explicit exception count for straightforward verification.
summary.exceptionCount = exceptions.length;

// Save the complete joined dataset compactly.
const outputPath = "data/extracted/fuse-links-by-premise.json";
await writeFile(
  outputPath,
  JSON.stringify({
    schemaVersion: 1,
    matchMethod: "source_table_and_device_id",
    deviceSummary,
    summary,
    byPremise: Object.fromEntries(byPremise),
  }) + "\n",
);

// Save readable exception details without repeating all successful links.
const exceptionPath = "data/extracted/fuse-link-exceptions.json";
await writeFile(
  exceptionPath,
  JSON.stringify(
    { schemaVersion: 1, deviceSummary, summary, records: exceptions },
    null,
    2,
  ) + "\n",
);

// Print clearly labeled device and reference summaries.
console.log("Distinct fuse devices:");
console.table(deviceSummary);
console.log("Fuse references in premise chains:");
console.table(summary);
console.log(`Joined links: ${outputPath}`);
console.log(`Exceptions: ${exceptionPath}`);