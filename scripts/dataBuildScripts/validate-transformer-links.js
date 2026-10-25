// Validate the customer-to-transformer relationship and save an exception report.
// Run from the project root so the relative file paths below resolve correctly.
// A unique location-code match is checked separately for circuit consistency.

// Import Node's built-in asynchronous file helpers. No extra package is needed.
import { readFile, writeFile } from "node:fs/promises";

// Read the compact customer file as text, then parse it into a JavaScript object.
// "await" waits for the file read; JSON.parse interprets its JSON contents.
// customers.fields contains column names; customers.rows contains value arrays.
const customers = JSON.parse(
  await readFile("data/extracted/customers.json", "utf8"),
);

// Read the QGIS export. Each feature contains geometry and a properties object.
// This validator uses the properties to match equipment, rather than proximity.
const transformers = JSON.parse(
  await readFile("data/extracted/transformers.geojson", "utf8"),
);

// Stop if the export is not a GeoJSON FeatureCollection with a features array.
// "||" means either invalid condition is enough to enter this if block.
// Throwing an Error stops the script instead of reporting misleading results.
if (
  transformers.type !== "FeatureCollection" ||
  !Array.isArray(transformers.features)
) {
  throw new Error("Expected a transformer GeoJSON FeatureCollection.");
}

// Build a name-to-column lookup, such as { premise: 8, transformer: 6, ... }.
// map creates [name, index] pairs; Object.fromEntries converts them to an object.
// Looking up columns by name keeps the script working if their order changes.
const columns = Object.fromEntries(
  customers.fields.map((name, index) => [name, index]),
);

// Check every customer field required for this particular relationship.
// "for...of" assigns each field name to "name" and runs the block once per name.
for (const name of ["premise", "transformer", "circuitId"]) {
  // Compare with undefined, because column index 0 is also a valid index.
  if (columns[name] === undefined) {
    throw new Error(`Customer data is missing field: ${name}`);
  }
}

// Normalize a lookup value to trimmed text. "??" replaces only null/undefined.
// Keep IDs as text: do not convert them to numbers or remove leading zeros.
// This helper cannot restore zeros already lost in an earlier numeric conversion.
const key = (value) => String(value ?? "").trim();

// Map each transformer location code to an array of equipment records.
// Retaining arrays prevents duplicate codes from silently overwriting a record.
const byLocation = new Map();

// Visit every exported feature to build the transformer lookup once.
for (const feature of transformers.features) {
  // properties holds attributes such as location_n, circuit_id, and id.
  const properties = feature.properties;

  // Require text identifiers so the export's field types remain intact.
  // "?." safely reads a field even if properties is null or undefined.
  if (
    typeof properties?.location_n !== "string" ||
    typeof properties?.circuit_id !== "string"
  ) {
    throw new Error("Transformer location_n and circuit_id must be text.");
  }

  // Normalize this location code; skip records without a usable location code.
  // "continue" moves to the next feature without running the remaining lines.
  const location = key(properties.location_n);
  if (!location) continue;

  // Reuse the existing group, or start an empty array for a new location code.
  // push adds this record; set stores the group under its location-code key.
  const records = byLocation.get(location) ?? [];
  records.push(properties);
  byLocation.set(location, records);
}

// Initialize the result object. The customer loop will update these values.
// Counts describe input records; the arrays retain exceptions for inspection.
const report = {
  // Keep both input sizes so the report can be compared with future exports.
  customerCount: customers.rows.length,
  transformerCount: transformers.features.length,
  // Count unique location-code matches, even if their circuit check later fails.
  matched: 0,
  // Distinguish absent references, missing matches, and multiple candidates.
  blankReferences: [],
  unresolved: [],
  ambiguous: [],
  // Record unique matches whose customer and transformer circuit IDs differ.
  circuitMismatches: [],
  // Convert the Map to [location, records] entries, retain groups with duplicates,
  // then summarize each group's location code and number of equipment records.
  // These are duplicate inventory keys, not necessarily ambiguous customer links.
  duplicateLocations: [...byLocation]
    .filter(([, records]) => records.length > 1)
    .map(([location, records]) => ({
      location,
      recordCount: records.length,
    })),
};

// Visit every customer row and classify its transformer reference.
for (const row of customers.rows) {
  // Resolve the required values using the named column indexes built above.
  // premise identifies the service location; transformer is its equipment reference.
  const premise = key(row[columns.premise]);
  const transformer = key(row[columns.transformer]);
  const customerCircuit = key(row[columns.circuitId]);

  // A blank reference is different from a supplied reference with no match.
  // Record the premise, then skip further matching for this customer.
  if (!transformer) {
    report.blankReferences.push({ premise });
    continue;
  }

  // Retrieve all candidates for this reference, or an empty array if absent.
  const matches = byLocation.get(transformer) ?? [];

  // Zero candidates: preserve the unresolved link for later investigation.
  if (matches.length === 0) {
    report.unresolved.push({ premise, transformer, customerCircuit });
  } else if (matches.length > 1) {
    // Multiple candidates: record the ambiguity instead of selecting one arbitrarily.
    report.ambiguous.push({
      premise,
      transformer,
      // Summarize candidate identities and circuits without copying every field.
      // "p" represents one candidate transformer properties object.
      candidates: matches.map((p) => ({
        source: p.eo_source_,
        id: key(p.id),
        circuit: key(p.circuit_id),
      })),
    });
  } else {
    // Exactly one candidate: count the unique match, then check its circuit.
    report.matched++;

    // matches[0] is safe to select here because exactly one candidate remains.
    const transformerCircuit = key(matches[0].circuit_id);
    // A location-code match on a different circuit needs separate investigation.
    if (customerCircuit !== transformerCircuit) {
      report.circuitMismatches.push({
        premise,
        transformer,
        customerCircuit,
        transformerCircuit,
      });
    }
  }
}

// Save the complete report in the existing ignored working-data directory.
// JSON.stringify(..., null, 2) formats it with two-space indentation.
// "\n" adds a final newline. Re-running replaces the previous report at this path.
const output = "data/extracted/transformer-link-report.json";
await writeFile(output, JSON.stringify(report, null, 2) + "\n");

// Print counts for a quick check while the saved JSON retains exception details.
// Customer exception arrays count affected rows; duplicateLocations counts keys.
console.table({
  customers: report.customerCount,
  transformers: report.transformerCount,
  matched: report.matched,
  blankReferences: report.blankReferences.length,
  unresolved: report.unresolved.length,
  ambiguous: report.ambiguous.length,
  circuitMismatches: report.circuitMismatches.length,
  duplicateLocations: report.duplicateLocations.length,
});

// Tell the person running the script where to inspect the detailed results.
console.log(`Report saved to ${output}`);
