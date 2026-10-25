// Export the remaining challenge shapefiles to local GeoJSON working files.
// Outputs stay in the existing ignored data/extracted directory.

// Import Node's built-in process, file, path, URL, and identifier helpers.
import { execFileSync } from "node:child_process";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Locate the project using this script's location.
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

// Use the installed QGIS tools. QGIS_BIN can override this on another computer.
const qgisBin =
  process.env.QGIS_BIN ?? "C:/Program Files/QGIS 3.44.15/bin";

const ogr2ogr = join(qgisBin, "ogr2ogr.exe");
const ogrinfo = join(qgisBin, "ogrinfo.exe");

// Locate the source folder beside this project.
// QGIS_DATA_ROOT can override the default source location.
const dataRoot = resolve(
  process.env.QGIS_DATA_ROOT ??
    join(projectRoot, "..", "Hackathon Data"),
);

// Keep complete working exports separate from browser-facing files.
const outputDir = resolve(projectRoot, "data/extracted");

// Each entry contains: source subfolder, shapefile name, output name.
const layers = [
  ["Data1", "Primary_ExportFeatures", "primary-lines"],
  ["Data2", "Secondary_ExportFeatures", "secondary-lines"],
  ["Data2", "Switch_Clip", "switches"],
  ["Data1", "Pole_Clip", "poles"],
  ["Data1", "arcos_prod_damage_09_28_Clip", "damage"],
  ["Data1", "Fire_Stations_E_Pairwis_Clip", "fire-stations"],
  ["Data1", "Ambulance_Servi_Pairwis_Clip", "ambulance-stations"],
];

// Read layer metadata through GDAL.
// This avoids loading large GeoJSON datasets into Node just to count features.
function inspectLayer(path) {
  const text = execFileSync(
    ogrinfo,
    ["-ro", "-so", "-al", "-json", path],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );

  const metadata = JSON.parse(text);

  // Each input and output in this batch should contain exactly one layer.
  if (metadata.layers?.length !== 1) {
    throw new Error(`Expected one GIS layer in ${path}`);
  }

  return metadata.layers[0];
}

// Check that both command-line tools exist and can run.
for (const executable of [ogr2ogr, ogrinfo]) {
  await access(executable);

  execFileSync(executable, ["--version"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

// Check every required source component before exporting anything.
for (const [folder, sourceName] of layers) {
  for (const extension of ["shp", "shx", "dbf", "prj"]) {
    const sourceFile = join(
      dataRoot,
      folder,
      `${sourceName}.${extension}`,
    );

    await access(sourceFile);
  }
}

// Ensure the working output directory exists.
await mkdir(outputDir, { recursive: true });

// Collect checked export results for the manifest and terminal summary.
const results = [];

// Export and validate each layer sequentially.
for (const [folder, sourceName, outputName] of layers) {
  // Construct source, final output, and unique temporary output paths.
  const sourcePath = join(dataRoot, folder, `${sourceName}.shp`);
  const outputPath = join(outputDir, `${outputName}.geojson`);
  const temporaryPath = join(
    outputDir,
    `.${outputName}-${randomUUID()}.geojson`,
  );

  // Read the source count and field names for comparison.
  const sourceMetadata = inspectLayer(sourcePath);

  console.log(`Exporting ${outputName}...`);

  // Use a temporary file so a failed export leaves the previous output intact.
  try {
    execFileSync(
      ogr2ogr,
      [
        "-f", "GeoJSON",
        temporaryPath,
        sourcePath,
        "-nln", outputName,
        "-t_srs", "EPSG:4326",
        "-dim", "XY",
        "-lco", "RFC7946=YES",
      ],
      {
        stdio: "inherit",
        windowsHide: true,
      },
    );

    // Inspect the generated file before accepting it.
    const exported = inspectLayer(temporaryPath);

    // Require the export to contain the same number of source features.
    if (exported.featureCount !== sourceMetadata.featureCount) {
      throw new Error(
        `${outputName}: expected ${sourceMetadata.featureCount} features, ` +
        `but exported ${exported.featureCount}.`,
      );
    }

    // Check that every source attribute name remains available.
    const exportedFields = new Set(
      exported.fields.map((field) => field.name),
    );

    const missingFields = sourceMetadata.fields
      .map((field) => field.name)
      .filter((name) => !exportedFields.has(name));

    if (missingFields.length > 0) {
      throw new Error(
        `${outputName}: missing fields: ${missingFields.join(", ")}`,
      );
    }

    // Promote the checked temporary file to its final output name.
    // Re-running replaces this layer's previous successful export.
    await rename(temporaryPath, outputPath);

    // Record useful metadata without copying the full dataset.
    results.push({
      layer: outputName,
      file: `${outputName}.geojson`,
      features: exported.featureCount,
      fields: exported.fields.length,
      geometry: exported.geometryFields?.[0]?.type,
    });
  } finally {
    // Run cleanup whether conversion succeeded or failed.
    // Remove only this temporary file; no recursive deletion is used.
    await rm(temporaryPath, { force: true });
  }
}

// Write the manifest only after all seven exports have succeeded.
const manifestPath = join(outputDir, "export-manifest.json");

await writeFile(
  manifestPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      coordinateSystem: "EPSG:4326",
      dimensions: 2,
      layers: results,
    },
    null,
    2,
  ) + "\n",
);

// Print a compact, readable verification table.
console.table(results);
console.log(`Export manifest: ${manifestPath}`);
