// Build candidate links between upstream reclosers and GIS recloser banks.
// These are location/type candidates, not verified device-identity matches.
// Run from the project root.

// Import Node's built-in asynchronous file functions.
import { readFile, writeFile } from "node:fs/promises";

// Read a JSON file and convert its contents into a JavaScript object.
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Load the generated upstream chains and exported GIS recloser banks.
const upstream = await readJson("data/extracted/upstream-by-premise.json");
const reclosers = await readJson("data/extracted/reclosers.geojson");

// Require the input structures used by this checkpoint.
if (
  upstream.schemaVersion !== 1 ||
  !upstream.byPremise ||
  reclosers.type !== "FeatureCollection" ||
  !Array.isArray(reclosers.features)
) {
  throw new Error("Unexpected upstream or recloser input structure.");
}

// Normalize identifiers and labels without converting them into numbers.
const key = (value) => String(value ?? "").trim();

// Represent a pair of values as an unambiguous lookup key.
// We use this for both device identities and location/type combinations.
const pairKey = (first, second) =>
  JSON.stringify([key(first), key(second)]);

// Index GIS banks by their location and specific equipment type.
// Arrays preserve multiple banks with the same location/type combination.
const gisByLocationType = new Map();

for (const feature of reclosers.features) {
  // Keep the bank's identity separate from the upstream device identity.
  const p = feature.properties;
  const candidate = {
    sourceTable: key(p?.eo_source_),
    assemblyId: key(p?.id),
    location: key(p?.location_n),
    deviceType: key(p?.device_typ),
    circuitId: key(p?.circuit_id),
  };

  // Stop if a required GIS reference is absent.
  if (Object.values(candidate).some((value) => value === "")) {
    throw new Error("A recloser bank has an incomplete reference.");
  }

  // Group this bank with other candidates at the same location and type.
  const lookup = pairKey(candidate.location, candidate.deviceType);
  const candidates = gisByLocationType.get(lookup) ?? [];
  candidates.push(candidate);
  gisByLocationType.set(lookup, candidates);
}

// Deduplicate upstream reclosers by their source-table/device-ID identity.
// The same device can occur in many premises' chains.
const upstreamDevices = new Map();

// Count all recloser occurrences separately from distinct device identities.
let upstreamReferences = 0;

// Visit each premise's chain, then each equipment entry in that chain.
for (const chain of Object.values(upstream.byPremise)) {
  for (const equipment of chain) {
    // Skip transformers, fuses, and other equipment for this checkpoint.
    if (!equipment.deviceType.startsWith("Recloser")) continue;

    // Read this occurrence's upstream identity and observed attributes.
    const sourceTable = key(equipment.sourceTable);
    const deviceId = key(equipment.deviceId);
    const reference = {
      location: key(equipment.location),
      deviceType: key(equipment.deviceType),
    };

    // Reject incomplete references before indexing them.
    if (
      !sourceTable ||
      !deviceId ||
      !reference.location ||
      !reference.deviceType
    ) {
      throw new Error("An upstream recloser reference is incomplete.");
    }

    // Retrieve the existing device or initialize its tracking record.
    const identity = pairKey(sourceTable, deviceId);
    const device = upstreamDevices.get(identity) ?? {
      sourceTable,
      deviceId,
      occurrences: 0,
      references: new Map(),
    };

    // Count this occurrence and retain distinct location/type observations.
    // Conflicting observations remain visible instead of overwriting each other.
    device.occurrences++;
    device.references.set(
      pairKey(reference.location, reference.deviceType),
      reference,
    );

    upstreamDevices.set(identity, device);
    upstreamReferences++;
  }
}

// Initialize counts for mutually exclusive candidate-matching outcomes.
const summary = {
  gisAssemblies: reclosers.features.length,
  upstreamDevices: upstreamDevices.size,
  upstreamReferences,
  unique_candidate: 0,
  ambiguous: 0,
  missing: 0,
  conflicting_references: 0,
};

// Collect plain objects that can be saved as JSON.
const records = [];

for (const device of upstreamDevices.values()) {
  // Convert the observation Map into a JSON-compatible array.
  const observedReferences = [...device.references.values()];

  // Preserve upstream identity, occurrence count, and all observations.
  const record = {
    upstream: {
      sourceTable: device.sourceTable,
      deviceId: device.deviceId,
    },
    occurrences: device.occurrences,
    observedReferences,
    candidates: [],
    status: "conflicting_references",
  };

  // Attempt matching only when the upstream identity has one consistent
  // location/type observation across all its occurrences.
  if (observedReferences.length === 1) {
    const reference = observedReferences[0];
    const lookup = pairKey(reference.location, reference.deviceType);

    record.candidates = gisByLocationType.get(lookup) ?? [];

    // Classify candidate cardinality without choosing an arbitrary bank.
    if (record.candidates.length === 0) {
      record.status = "missing";
    } else if (record.candidates.length === 1) {
      record.status = "unique_candidate";
    } else {
      record.status = "ambiguous";
    }
  }

  // Count this device's outcome and retain its complete crosswalk record.
  summary[record.status]++;
  records.push(record);
}

// Keep non-unique outcomes in a smaller exception report.
const exceptions = records.filter(
  (record) => record.status !== "unique_candidate",
);

// Include an explicit exception count so no manual counting is needed.
summary.exceptionCount = exceptions.length;

// Record the matching method alongside the generated crosswalk.
const output = {
  schemaVersion: 1,
  matchMethod: "location_and_device_type",
  summary,
  records,
};

// Save the complete crosswalk with readable formatting.
const outputPath = "data/extracted/recloser-crosswalk.json";
await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");

// Save the smaller exception report using the same summary and method.
const exceptionPath = "data/extracted/recloser-crosswalk-exceptions.json";
await writeFile(
  exceptionPath,
  JSON.stringify({ ...output, records: exceptions }, null, 2) + "\n",
);

// Print counts and file locations for straightforward verification.
console.table(summary);
console.log(`Crosswalk: ${outputPath}`);
console.log(`Exceptions: ${exceptionPath}`);

// Compare recloser candidates with customer circuit context.
// Each result represents one recloser occurrence in one premise's chain.

// Load customer records using the readJson helper defined above.
const customers = await readJson("data/extracted/customers.json");

// Resolve the customer columns by name.
const customerColumns = Object.fromEntries(
  customers.fields.map((name, index) => [name, index]),
);

// Require the two customer fields needed for circuit comparisons.
for (const name of ["premise", "circuitId"]) {
  if (customerColumns[name] === undefined) {
    throw new Error(`Customer data is missing field: ${name}`);
  }
}

// Index customer circuit IDs by premise.
// Map.has() will distinguish an absent customer from a blank circuit field.
const customerCircuitByPremise = new Map();

for (const row of customers.rows) {
  // Normalize identifiers while retaining them as text.
  const premise = key(row[customerColumns.premise]);
  const circuitId = key(row[customerColumns.circuitId]);

  // Reject blank or duplicate premise identifiers.
  if (!premise || customerCircuitByPremise.has(premise)) {
    throw new Error(`Blank or duplicate customer premise: ${premise}`);
  }

  customerCircuitByPremise.set(premise, circuitId);
}

// Index the crosswalk records already built during this script run.
const crosswalkByDevice = new Map(
  records.map((record) => [
    pairKey(record.upstream.sourceTable, record.upstream.deviceId),
    record,
  ]),
);

// Count reference-level outcomes separately from distinct-device outcomes.
const circuitSummary = {
  references: 0,
  circuit_agrees: 0,
  circuit_conflict: 0,
  ambiguous_candidate: 0,
  missing_candidate: 0,
  conflicting_references: 0,
  missing_customer: 0,
  missing_customer_circuit: 0,
};

// Store joined references by premise and collect exceptions separately.
const linksByPremise = new Map();
const circuitExceptions = [];

// Iterate upstream premises so source-only premises remain represented.
for (const [premise, chain] of Object.entries(upstream.byPremise)) {
  // Collect this premise's recloser references.
  const links = [];

  for (const equipment of chain) {
    // Other equipment types will be integrated in later checkpoints.
    if (!equipment.deviceType.startsWith("Recloser")) continue;

    // Retrieve this device's crosswalk record from the same script run.
    const identity = pairKey(equipment.sourceTable, equipment.deviceId);
    const mapping = crosswalkByDevice.get(identity);

    // Every selected device should have been indexed by the earlier section.
    if (!mapping) {
      throw new Error(`Missing generated recloser crosswalk: ${identity}`);
    }

    // Preserve the difference between an absent customer and a blank circuit.
    const customerPresent = customerCircuitByPremise.has(premise);
    const customerCircuit = customerPresent
      ? customerCircuitByPremise.get(premise)
      : null;

    // Leave the comparison unavailable until a unique candidate can be checked.
    let circuitAgrees = null;
    let status;

    // Preserve unresolved candidate matching before checking customer context.
    if (mapping.status === "ambiguous") {
      status = "ambiguous_candidate";
    } else if (mapping.status === "missing") {
      status = "missing_candidate";
    } else if (mapping.status === "conflicting_references") {
      status = "conflicting_references";
    } else if (
      mapping.status !== "unique_candidate" ||
      mapping.candidates.length !== 1
    ) {
      // Reject an unexpected internal crosswalk structure.
      throw new Error(`Invalid crosswalk outcome for ${identity}.`);
    } else if (!customerPresent) {
      status = "missing_customer";
    } else if (!customerCircuit) {
      status = "missing_customer_circuit";
    } else {
      // Compare circuits only for one candidate and usable customer context.
      circuitAgrees =
        customerCircuit === mapping.candidates[0].circuitId;

      status = circuitAgrees ? "circuit_agrees" : "circuit_conflict";
    }

    // Preserve the upstream reference, every candidate, and available context.
    const link = {
      premise,
      hop: equipment.hop,
      upstream: {
        sourceTable: key(equipment.sourceTable),
        deviceId: key(equipment.deviceId),
        location: key(equipment.location),
        deviceType: key(equipment.deviceType),
      },
      candidateStatus: mapping.status,
      gisCandidates: mapping.candidates,
      customerPresent,
      customerCircuit,
      circuitAgrees,
      status,
    };

    // Count this reference and retain it under its premise.
    circuitSummary.references++;
    circuitSummary[status]++;
    links.push(link);

    // Retain all outcomes requiring review in the exception report.
    if (status !== "circuit_agrees") {
      circuitExceptions.push(link);
    }
  }

  // Only premises containing reclosers need entries in this dataset.
  if (links.length > 0) {
    linksByPremise.set(premise, links);
  }
}

// Include the exception count explicitly for easy verification.
circuitSummary.exceptionCount = circuitExceptions.length;

// Save all joined reference records compactly.
const linksPath = "data/extracted/recloser-links-by-premise.json";
await writeFile(
  linksPath,
  JSON.stringify({
    schemaVersion: 1,
    crosswalkFile: "data/extracted/recloser-crosswalk.json",
    summary: circuitSummary,
    byPremise: Object.fromEntries(linksByPremise),
  }) + "\n",
);

// Save readable exception details without requiring manual record counting.
const circuitReportPath = "data/extracted/recloser-circuit-exceptions.json";
await writeFile(
  circuitReportPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      summary: circuitSummary,
      records: circuitExceptions,
    },
    null,
    2,
  ) + "\n",
);

// Print the new reference-level summary after the existing device summary.
console.table(circuitSummary);
console.log(`Recloser links: ${linksPath}`);
console.log(`Circuit exceptions: ${circuitReportPath}`);