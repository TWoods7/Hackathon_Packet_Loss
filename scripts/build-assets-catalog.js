// Normalize equipment and line exports into one consistent internal schema.
// Preserve geometry and source references. Public field filtering comes later.
// Run from the project root.

// Import Node's built-in file and path functions.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// Define the working-data and normalized-output directories.
const inputDir = "data/extracted";
const outputDir = join(inputDir, "normalized");
const assetDir = join(outputDir, "assets");

// Each entry contains an exported filename and its normalized asset type.
const layers = [
  ["transformers", "transformer"],
  ["reclosers", "recloser_bank"],
  ["fuses", "fuse"],
  ["switches", "switch"],
  ["poles", "pole"],
  ["primary-lines", "primary_line"],
  ["secondary-lines", "secondary_line"],
];

// Normalize identifiers as text; use null for unavailable optional values.
const key = (value) => String(value ?? "").trim();
const optional = (value) => key(value) || null;

// Track inventory identities and correlated circuit observations.
const seenAssets = new Set();
const circuitObservations = new Map();
const refsByRawCircuitId = new Map();

// Collect layer summaries and count assets without circuit assignments.
const layerSummaries = [];
let assetsWithoutCircuit = 0;

// Create the output directory and any missing parents.
await mkdir(assetDir, { recursive: true });

// Process one layer at a time rather than loading every export together.
for (const [layerName, assetType] of layers) {
  // Read this layer's GeoJSON.
  const sourcePath = join(inputDir, `${layerName}.geojson`);
  const data = JSON.parse(await readFile(sourcePath, "utf8"));

  // Require the expected feature collection structure.
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    throw new Error(`Invalid GeoJSON collection: ${sourcePath}`);
  }

  // Replace features in the in-memory array with normalized versions.
  // The original source file is not modified.
  for (let index = 0; index < data.features.length; index++) {
    const feature = data.features[index];
    const p = feature.properties ?? {};

    // Preserve the original entity identity used by upstream joins.
    const sourceTable = key(p.eo_source_);
    const sourceId = key(p.id);

    if (!sourceTable || !sourceId) {
      throw new Error(`${layerName}: missing source table or source ID.`);
    }

    // Qualify the inventory feature ID by layer.
    // entityKey separately preserves the original source-table/ID identity.
    const assetId = JSON.stringify([layerName, sourceTable, sourceId]);
    const entityKey = JSON.stringify([sourceTable, sourceId]);

    // Reject duplicate inventory feature identities.
    if (seenAssets.has(assetId)) {
      throw new Error(`Duplicate inventory asset: ${assetId}`);
    }
    seenAssets.add(assetId);

    // Read the correlated circuit attributes from this source record.
    const circuitId = optional(p.circuit_id);
    const substation = optional(p.aep_statio);
    const circuitLabel = optional(p.aep_circui);
    let circuitRef = null;

    // Preserve circuit observations without merging by raw ID alone.
    if (circuitId !== null) {
      circuitRef = JSON.stringify([
        circuitId,
        substation,
        circuitLabel,
      ]);

      // Retrieve or initialize this exact observed combination.
      const observation = circuitObservations.get(circuitRef) ?? {
        circuitRef,
        rawCircuitId: circuitId,
        substation,
        label: circuitLabel,
        sourceLayers: new Set(),
        assetCounts: {},
      };

      // Retain the layers supporting this observation and their asset counts.
      observation.sourceLayers.add(layerName);
      observation.assetCounts[layerName] =
        (observation.assetCounts[layerName] ?? 0) + 1;

      circuitObservations.set(circuitRef, observation);

      // Also index every observed reference associated with this raw ID.
      const references = refsByRawCircuitId.get(circuitId) ?? new Set();
      references.add(circuitRef);
      refsByRawCircuitId.set(circuitId, references);
    } else {
      // Poles currently have no supplied circuit assignment.
      assetsWithoutCircuit++;
    }

    // Build the common asset schema while preserving original geometry.
    // Location references remain neutral: no flow direction is inferred.
    data.features[index] = {
      type: "Feature",
      id: assetId,
      geometry: feature.geometry,
      properties: {
        assetType,
        sourceLayer: layerName,
        sourceTable,
        sourceId,
        entityKey,
        globalId: optional(p.global_id),
        deviceType: optional(p.device_typ),
        locationRef: optional(p.location_n),
        locationRef2: optional(p.location_1),
        upstreamRef: optional(p.upstream_l),
        circuitId,
        circuitRef,
        substation,
        circuitLabel,

        // Inventory and normal-state fields are not live outage status.
        inventoryStatus: optional(p.status),
        normalState: optional(p.normal_sta),
      },
    };
  }

  // Save this normalized layer before processing the next large input.
  const filename = `${layerName}.geojson`;

  await writeFile(
    join(assetDir, filename),
    JSON.stringify({
      type: "FeatureCollection",
      name: layerName,
      features: data.features,
    }) + "\n",
  );

  // Record the layer's count and path for the manifest.
  layerSummaries.push({
    layer: layerName,
    assetType,
    features: data.features.length,
    file: `assets/${filename}`,
  });

  console.log(`Normalized ${layerName}: ${data.features.length} features`);
}

// Identify raw IDs associated with multiple station/label observations.
const reviewRawIds = [...refsByRawCircuitId]
  .filter(([, references]) => references.size > 1)
  .map(([rawId]) => rawId);

// Convert circuit tracking structures into JSON-compatible records.
const circuitRecords = [...circuitObservations.values()].map(
  (observation) => ({
    ...observation,
    sourceLayers: [...observation.sourceLayers].sort(),
    requiresReview:
      refsByRawCircuitId.get(observation.rawCircuitId).size > 1,
  }),
);

// Build the secondary lookup from raw IDs to observed circuit references.
const byRawId = Object.fromEntries(
  [...refsByRawCircuitId].map(([rawId, references]) => [
    rawId,
    [...references],
  ]),
);

// Save correlated circuit observations and their provenance.
// These records describe source references, not verified physical circuits.
await writeFile(
  join(outputDir, "circuits.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      rawCircuitIdCount: refsByRawCircuitId.size,
      referenceCount: circuitRecords.length,
      reviewRawIds,
      byRawId,
      records: circuitRecords,
    },
    null,
    2,
  ) + "\n",
);

// Describe the generated inventory and its available files.
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  coordinateSystem: "EPSG:4326",
  assetCount: seenAssets.size,
  assetsWithoutCircuit,
  rawCircuitIds: refsByRawCircuitId.size,
  circuitReferences: circuitRecords.length,
  rawCircuitIdsRequiringReview: reviewRawIds.length,
  circuitsFile: "circuits.json",
  layers: layerSummaries,
};

// Save a small manifest that can be inspected without opening large layers.
await writeFile(
  join(outputDir, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

// Print the layer counts and overall verification totals.
console.table(layerSummaries);
console.table({
  assets: manifest.assetCount,
  assetsWithoutCircuit: manifest.assetsWithoutCircuit,
  rawCircuitIds: manifest.rawCircuitIds,
  circuitReferences: manifest.circuitReferences,
  rawCircuitIdsRequiringReview: manifest.rawCircuitIdsRequiringReview,
});

console.log(`Normalized inventory saved in ${outputDir}`);