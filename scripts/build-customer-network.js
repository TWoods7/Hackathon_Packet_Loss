// Join customer, upstream, and transformer GIS information.
// Run from the project root. Preserve each source's original references.

// Import Node's built-in asynchronous file functions.
import { readFile, writeFile } from "node:fs/promises";

// Read and parse a JSON file. This helper avoids repeating the same code.
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Load the three datasets already checked by our validation scripts.
const customers = await readJson("public/data/customers.json");
const upstream = await readJson("data/extracted/upstream-by-premise.json");
const transformers = await readJson("data/extracted/transformers.geojson");

// Normalize lookup values while preserving identifiers as text.
const key = (value) => String(value ?? "").trim();

// Combine source table and device ID into an unambiguous lookup key.
// JSON.stringify preserves the boundary between the two identifiers.
const deviceKey = (sourceTable, deviceId) =>
  JSON.stringify([key(sourceTable), key(deviceId)]);

// Check the basic input structures before accessing their contents.
if (
  upstream.schemaVersion !== 1 ||
  !upstream.byPremise ||
  transformers.type !== "FeatureCollection" ||
  !Array.isArray(transformers.features)
) {
  throw new Error("Unexpected upstream or transformer input structure.");
}

// Build a lookup from customer field names to their column positions.
const columns = Object.fromEntries(
  customers.fields.map((name, index) => [name, index]),
);

// Require the customer fields used by this join.
for (const name of ["premise", "transformer", "circuitId"]) {
  if (columns[name] === undefined) {
    throw new Error(`Customer data is missing field: ${name}`);
  }
}

// Index GIS transformers by source-table/device-ID identity.
// Arrays preserve duplicate identities instead of overwriting candidates.
const gisByIdentity = new Map();

for (const feature of transformers.features) {
  // Extract only the GIS attributes needed for this joined dataset.
  const p = feature.properties;
  const gisRecord = {
    sourceTable: key(p?.eo_source_),
    deviceId: key(p?.id),
    location: key(p?.location_n),
    circuitId: key(p?.circuit_id),
  };

  // Reject incomplete GIS references before adding them to the index.
  if (Object.values(gisRecord).some((value) => value === "")) {
    throw new Error("A GIS transformer has an incomplete reference.");
  }

  // Retrieve the candidate group, append this record, and store the group.
  const identity = deviceKey(gisRecord.sourceTable, gisRecord.deviceId);
  const candidates = gisByIdentity.get(identity) ?? [];
  candidates.push(gisRecord);
  gisByIdentity.set(identity, candidates);
}

// Initialize mutually exclusive reconciliation-status counts.
// Every customer will receive exactly one of these statuses.
const summary = {
  customers: customers.rows.length,
  consistent: 0,
  source_conflict: 0,
  missing_gis: 0,
  missing_upstream: 0,
  ambiguous_gis: 0,
};

// Store all joined records, plus a smaller list of cases needing review.
const byPremise = new Map();
const exceptions = [];

// Build one joined record for every customer, including unmatched customers.
for (const row of customers.rows) {
  // Read the premise identifier and reject blank or duplicate records.
  const premise = key(row[columns.premise]);

  if (!premise || byPremise.has(premise)) {
    throw new Error(`Blank or duplicate customer premise: ${premise}`);
  }

  // Preserve the customer's declared values separately from other sources.
  // null checks mean unavailable; false checks mean an actual disagreement.
  const record = {
    premise,
    declared: {
      location: key(row[columns.transformer]),
      circuitId: key(row[columns.circuitId]),
    },
    upstream: null,
    gisCandidates: [],
    checks: {
      customerVsUpstreamLocation: null,
      upstreamVsGISLocation: null,
      customerVsGISLocation: null,
      customerVsGISCircuit: null,
    },
    status: "missing_upstream",
  };

  // Only attempt the upstream identity join when a chain exists.
  if (Object.hasOwn(upstream.byPremise, premise)) {
    const chain = upstream.byPremise[premise];
    const first = chain?.[0];

    // This checkpoint expects the distribution-transformer first hop
    // established by our upstream validator.
    if (
      !Array.isArray(chain) ||
      first?.hop !== 1 ||
      first?.deviceType !== "Distribution" ||
      first?.sourceTable !== "eo_power_xfrmr_inst" ||
      typeof first?.deviceId !== "string" ||
      !first.deviceId.trim() ||
      typeof first?.location !== "string" ||
      !first.location.trim()
    ) {
      throw new Error(`Invalid transformer first hop for ${premise}.`);
    }

    // Preserve the upstream reference without replacing the declared one.
    record.upstream = {
      sourceTable: key(first.sourceTable),
      deviceId: key(first.deviceId),
      location: key(first.location),
    };

    // This comparison remains available even when GIS has no matching record.
    record.checks.customerVsUpstreamLocation =
      record.declared.location === record.upstream.location;

    // Find GIS candidates using identity rather than geographic proximity.
    const identity = deviceKey(
      record.upstream.sourceTable,
      record.upstream.deviceId,
    );
    record.gisCandidates = gisByIdentity.get(identity) ?? [];

    // Classify missing and ambiguous identities before comparing GIS fields.
    if (record.gisCandidates.length === 0) {
      record.status = "missing_gis";
    } else if (record.gisCandidates.length > 1) {
      record.status = "ambiguous_gis";
    } else {
      // Exactly one candidate permits location and circuit comparisons.
      const gis = record.gisCandidates[0];

      record.checks.upstreamVsGISLocation =
        record.upstream.location === gis.location;

      record.checks.customerVsGISLocation =
        record.declared.location === gis.location;

      // Compare the customer circuit with the GIS transformer circuit.
      // This does not check the upstream chain's terminal circuit.
      record.checks.customerVsGISCircuit =
        record.declared.circuitId === gis.circuitId;

      // Only an explicit false represents a disagreement.
      const hasConflict = Object.values(record.checks).some(
        (value) => value === false,
      );

      record.status = hasConflict ? "source_conflict" : "consistent";
    }
  }

  // Retain every customer and increment its single status category.
  byPremise.set(premise, record);
  summary[record.status]++;

  // Keep exceptions separately so they can be reviewed in a smaller file.
  if (record.status !== "consistent") {
    exceptions.push(record);
  }
}

// Define the joined dataset. Full chains remain in the upstream file,
// accessible using the same premise identifier.
const output = {
  schemaVersion: 1,
  upstreamFile: "data/extracted/upstream-by-premise.json",
  summary,
  byPremise: Object.fromEntries(byPremise),
};

// Save the complete dataset compactly because it contains many records.
const datasetPath = "data/extracted/customer-network.json";
await writeFile(datasetPath, JSON.stringify(output) + "\n");

// Save a readable exception report with the same summary.
const exceptionPath = "data/extracted/customer-network-exceptions.json";
await writeFile(
  exceptionPath,
  JSON.stringify({ schemaVersion: 1, summary, records: exceptions }, null, 2)
    + "\n",
);

// Print the status counts and generated file locations.
console.table(summary);
console.log(`Joined dataset: ${datasetPath}`);
console.log(`Exception report: ${exceptionPath}`);