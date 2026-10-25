// Convert the organizer's upstream TXT into ordered equipment chains.
// Run from the project root so these relative paths resolve correctly.

// Import Node's built-in asynchronous file-reading and writing functions.
import { readFile, writeFile } from "node:fs/promises";

// Define the local source and generated output paths.
const inputPath = "data/extracted/matched_upstream.txt";
const outputPath = "data/extracted/upstream-by-premise.json";

// Read the source as text. await waits until the file has been loaded.
const source = await readFile(inputPath, "utf8");

// Remove an optional encoding marker, then split into individual lines.
// This handles both Windows and Unix line endings.
const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);

// Store one ordered equipment array per premise.
// Keep the premise identifiers as strings to preserve leading zeros.
const byPremise = new Map();

// Count equipment entries across all premises, including shared devices.
// This counts relationship rows, not unique physical devices.
let hopCount = 0;

// Visit each source line. entries() supplies its index and text.
for (const [lineIndex, line] of lines.entries()) {
  // Human-readable line numbers start at 1 rather than 0.
  const lineNumber = lineIndex + 1;

  // Ignore empty lines, including a possible final newline.
  if (!line.trim()) continue;

  // Tabs separate the premise from its equipment entries.
  // The rest operator (...) collects the remaining entries into an array.
  const [premiseValue, ...equipmentEntries] = line.split("\t");
  const premise = premiseValue.trim();

  // Stop if a line lacks a premise or any equipment.
  if (!premise || equipmentEntries.length === 0) {
    throw new Error(`Line ${lineNumber}: missing premise or equipment.`);
  }

  // Reject duplicate premise lines instead of silently overwriting a chain.
  if (byPremise.has(premise)) {
    throw new Error(`Line ${lineNumber}: duplicate premise ${premise}.`);
  }

  // Convert each equipment entry into a structured object.
  // map preserves the order of entries in the original source line.
  const chain = equipmentEntries.map((entry, hopIndex) => {
    // Split the equipment fields and remove surrounding whitespace.
    const parts = entry.split("*").map((part) => part.trim());

    // Require exactly four nonempty fields before accepting an entry.
    if (parts.length !== 4 || parts.some((part) => part === "")) {
      throw new Error(`Line ${lineNumber}: invalid equipment entry.`);
    }

    // Assign descriptive names to the four source fields.
    // All four remain strings; no identifier is converted to a number.
    const [sourceTable, deviceId, deviceType, location] = parts;

    // Store the equipment and its position within this premise's chain.
    // hop is an ordinal number: the first equipment entry is hop 1.
    return {
      hop: hopIndex + 1,
      sourceTable,
      deviceId,
      deviceType,
      location,
    };
  });

  // Save the complete ordered chain and update the relationship count.
  byPremise.set(premise, chain);
  hopCount += chain.length;
}

// Stop if the input contained no usable premise records.
if (byPremise.size === 0) {
  throw new Error("The upstream file contained no premise records.");
}

// Convert the Map into a JSON-compatible object keyed by premise.
// The schema version identifies the structure of this generated file.
const output = {
  schemaVersion: 1,
  premiseCount: byPremise.size,
  hopCount,
  byPremise: Object.fromEntries(byPremise),
};

// Write compact JSON because this dataset contains many equipment entries.
// Re-running replaces the generated file; the source TXT stays intact.
await writeFile(outputPath, JSON.stringify(output) + "\n");

// Print summary counts rather than the entire generated dataset.
console.table({
  premises: output.premiseCount,
  upstreamHops: output.hopCount,
});

// Show where the generated data was saved.
console.log(`Saved ordered upstream chains to ${outputPath}`);