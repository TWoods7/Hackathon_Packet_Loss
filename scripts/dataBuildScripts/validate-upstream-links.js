// Compare customer records with their generated upstream chains.
// Run from the project root. Source records are preserved.

// Import Node's built-in asynchronous file functions.
import { readFile, writeFile } from "node:fs/promises";

// Load the customer table and generated upstream data.
const customers = JSON.parse(
  await readFile("data/extracted/customers.json", "utf8"),
);
const upstream = JSON.parse(
  await readFile("data/extracted/upstream-by-premise.json", "utf8"),
);

// Require the structure produced by our version-1 upstream builder.
if (
  upstream.schemaVersion !== 1 ||
  !upstream.byPremise ||
  typeof upstream.byPremise !== "object" ||
  Array.isArray(upstream.byPremise)
) {
  throw new Error("Expected version-1 upstream data with byPremise.");
}

// Turn the upstream object into [premise, chain] pairs for inspection.
const upstreamEntries = Object.entries(upstream.byPremise);

// Recount relationship rows to check the generated file's metadata.
let countedHops = 0;

// Validate every chain, including premises absent from the customer table.
for (const [premise, chain] of upstreamEntries) {
  // A recorded premise must have a nonempty equipment array.
  if (!premise.trim() || !Array.isArray(chain) || chain.length === 0) {
    throw new Error(`Invalid upstream chain for premise ${premise}.`);
  }

  // Check equipment order and require nonempty text identifiers.
  for (const [index, equipment] of chain.entries()) {
    const requiredFields = [
      "sourceTable",
      "deviceId",
      "deviceType",
      "location",
    ];

    // some() returns true if any required field fails this check.
    const invalidField = requiredFields.some(
      (field) =>
        typeof equipment?.[field] !== "string" ||
        equipment[field].trim() === "",
    );

    // Hop numbers must follow their array positions: 1, 2, 3, ...
    if (invalidField || equipment.hop !== index + 1) {
      throw new Error(`Invalid equipment entry for premise ${premise}.`);
    }
  }

  // In this supplied dataset, hop 1 represents a distribution transformer.
  // Stop if another dataset breaks that assumption.
  const first = chain[0];
  if (
    first.deviceType !== "Distribution" ||
    first.sourceTable !== "eo_power_xfrmr_inst"
  ) {
    throw new Error(`Unexpected first-hop equipment for ${premise}.`);
  }

  // Add this chain's relationship rows to the total.
  countedHops += chain.length;
}

// Reject inconsistent metadata instead of trusting its stored counts.
if (
  upstreamEntries.length !== upstream.premiseCount ||
  countedHops !== upstream.hopCount
) {
  throw new Error("Upstream metadata does not match its actual contents.");
}

// Resolve customer columns by name rather than assuming fixed positions.
const columns = Object.fromEntries(
  customers.fields.map((name, index) => [name, index]),
);

// Ensure all customer fields needed for this comparison are available.
for (const name of ["premise", "transformer", "circuitId"]) {
  if (columns[name] === undefined) {
    throw new Error(`Customer data is missing field: ${name}`);
  }
}

// Normalize lookup values without converting identifiers into numbers.
const key = (value) => String(value ?? "").trim();

// Track customer premises for duplicate checks and the reverse comparison.
const customerPremises = new Set();

// Initialize summary counts and detailed exception lists.
const report = {
  customerCount: customers.rows.length,
  upstreamPremiseCount: upstreamEntries.length,
  customersWithChain: 0,
  transformerAgreements: 0,
  missingChains: [],
  upstreamOnlyPremises: [],
  transformerDisagreements: [],
};

// Compare each customer with its upstream record.
for (const row of customers.rows) {
  // Extract the customer's identifiers using our column lookup.
  const premise = key(row[columns.premise]);
  const declaredTransformer = key(row[columns.transformer]);
  const customerCircuit = key(row[columns.circuitId]);

  // Reject absent or duplicate premises before counting relationships.
  if (!premise || customerPremises.has(premise)) {
    throw new Error(`Blank or duplicate customer premise: ${premise}`);
  }
  customerPremises.add(premise);

  // Check whether this premise actually appears in the upstream object.
  if (!Object.hasOwn(upstream.byPremise, premise)) {
    report.missingChains.push({
      premise,
      declaredTransformer,
      customerCircuit,
    });

    // No chain is available, so move to the next customer.
    continue;
  }

  // The earlier validation established that this chain has a valid hop 1.
  const first = upstream.byPremise[premise][0];
  const upstreamTransformer = key(first.location);
  report.customersWithChain++;

  // Count agreements; retain both source values when they disagree.
  if (declaredTransformer === upstreamTransformer) {
    report.transformerAgreements++;
  } else {
    report.transformerDisagreements.push({
      premise,
      customerCircuit,
      declaredTransformer,
      upstreamTransformer,
      upstreamSourceTable: first.sourceTable,
      upstreamDeviceId: first.deviceId,
    });
  }
}

// Check the reverse direction: upstream premises with no customer record.
for (const [premise] of upstreamEntries) {
  if (!customerPremises.has(premise)) {
    report.upstreamOnlyPremises.push(premise);
  }
}

// Save a readable report in our existing ignored working-data directory.
const outputPath = "data/extracted/upstream-link-report.json";
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");

// Print summary counts while retaining detailed exceptions in the report.
console.table({
  customers: report.customerCount,
  upstreamPremises: report.upstreamPremiseCount,
  customersWithChain: report.customersWithChain,
  missingChains: report.missingChains.length,
  upstreamOnlyPremises: report.upstreamOnlyPremises.length,
  transformerAgreements: report.transformerAgreements,
  transformerDisagreements: report.transformerDisagreements.length,
});

// Show where the detailed comparison was saved.
console.log(`Report saved to ${outputPath}`);