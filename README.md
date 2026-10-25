# Packet Loss data pipeline

This project contains a Vite, Google Maps, and deck.gl application plus local scripts that prepare the challenge GIS and upstream-network data.

The current data milestone provides a normalized utility-asset inventory, observed circuit references, and customer/upstream relationship files with explicit exceptions. It does not yet provide a backend API or a reviewed browser-facing export of the normalized inventory. Damage and emergency-facility data have been exported but are not included in the normalized utility-asset catalog.

## What Git shares

Commit the scripts and this README. `data/extracted/` is ignored, including its `normalized/` subdirectory. A teammate cloning or pulling the branch receives the pipeline code, not the generated data.

Teammates must obtain the organizer's source package and rebuild locally, or receive a private copy of the working-data directory through the team's agreed sharing method. Keep raw and intermediate files out of public hosting.

## Requirements and source setup

- Node.js; the pipeline was tested locally with Node 24.22.1.
- QGIS/GDAL for the batch exporter; the current default is `C:/Program Files/QGIS 3.44.15/bin`.
- The same organizer-supplied Data1, Data2, and Matched_Upstream extracts, retaining the shapefile companion files.

The batch exporter expects this default layout:

```text
Documents/
  Hackathon Data/
    Data1/
    Data2/
    Matched_Upstream/
      matched_upstream.txt
  Hackathon_Packet_Loss/
    scripts/dataBuildScripts/
    public/data/customers.json
    data/extracted/
```

The source files used for the local build were already available in the other checkout at `../../HackI-O-PacketLoss/data/extracted/`. That directory contains `Data1/`, `Data2/`, and `matched_upstream/matched_upstream.txt`. The configuration below checks the default layout first, then this existing checkout.

Follow the numbered steps in order, from the repository root, in the **same PowerShell session**. Environment settings below apply only to that session; repeat step 4 if you open another terminal.

### 1. Prepare PowerShell and Node

```powershell
$ErrorActionPreference = "Stop"

# Confirm this terminal is in the repository root.
if (-not (Test-Path -LiteralPath ".\scripts\dataBuildScripts\export-remaining-layers.js")) {
  throw "Open PowerShell in the Hackathon_Packet_Loss repository root."
}

# Add the installed Node directory to this terminal session's search path.
$env:Path = "C:\Program Files\nodejs;" + $env:Path

# Check that Node is available.
node --version
if ($LASTEXITCODE -ne 0) { throw "Node.js is not available." }
```

### 2. Stop the dev server and install dependencies

Stop this project's running dev server with **Ctrl+C** in its terminal before reinstalling dependencies. During the local run, Vite and esbuild held files open, causing `npm.cmd ci` to fail with `EPERM` / `unlink` errors for Rollup or esbuild.

If the original terminal is unavailable, this optional cleanup stops only Vite and esbuild processes whose paths point into this repository. Do not stop every Node process on the computer.

```powershell
$projectPath = (Get-Location).Path
$projectProcesses = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq "esbuild.exe" -and $_.ExecutablePath -like ($projectPath + "\node_modules\*")) -or
  ($_.Name -eq "node.exe" -and $_.CommandLine -like ("*" + $projectPath + "\node_modules*") -and $_.CommandLine -like "*vite\bin\vite.js*")
}
foreach ($projectProcess in ($projectProcesses | Sort-Object Name)) {
  Stop-Process -Id $projectProcess.ProcessId -ErrorAction Stop
}
```

```powershell
# Install the existing application's dependencies.
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed; resolve any file locks before continuing." }
```

### 3. Install QGIS/GDAL if missing

The local build required installing QGIS 3.44.15 LTR, which includes `ogr2ogr.exe` and `ogrinfo.exe`. The commands below use the official QGIS package through Windows Package Manager and skip installation when both tools are already present at the tested location. Allow Windows administrator approval if the installer requests it.

```powershell
$qgisRoot = "C:\Program Files\QGIS 3.44.15"
if (-not (Test-Path -LiteralPath (Join-Path $qgisRoot "bin\ogr2ogr.exe")) -or
    -not (Test-Path -LiteralPath (Join-Path $qgisRoot "bin\ogrinfo.exe"))) {
  winget show --id OSGeo.QGIS_LTR --exact --source winget --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "Could not find the QGIS installer." }
  winget install --id OSGeo.QGIS_LTR --exact --version 3.44.15 --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "QGIS installation failed." }
}
```

### 4. Configure GDAL and locate the source data

Set the resources from the **same QGIS installation** as the executables. The GDAL data folder in this installation is `apps/gdal/share/gdal`; PROJ uses `share/proj`. Do not substitute resource files from another Python/GDAL installation.

```powershell
$env:QGIS_BIN = Join-Path $qgisRoot "bin"
$env:GDAL_DATA = Join-Path $qgisRoot "apps\gdal\share\gdal"
$env:GDAL_DRIVER_PATH = Join-Path $qgisRoot "apps\gdal\lib\gdalplugins"
$env:PROJ_DATA = Join-Path $qgisRoot "share\proj"
$env:Path = "$env:QGIS_BIN;" + $env:Path

# Set QGIS_DATA_ROOT yourself before this block to use another source package.
# Its Data1 and Data2 folders must be direct children of that directory.
if (-not $env:QGIS_DATA_ROOT) {
  $sourceCandidates = @(
    (Join-Path (Get-Location).Path "..\Hackathon Data"),
    (Join-Path (Get-Location).Path "..\..\HackI-O-PacketLoss\data\extracted")
  )
  $sourceRoot = $sourceCandidates | Where-Object {
    (Test-Path -LiteralPath (Join-Path $_ "Data1")) -and
    (Test-Path -LiteralPath (Join-Path $_ "Data2"))
  } | Select-Object -First 1
  if (-not $sourceRoot) { throw "Set QGIS_DATA_ROOT to the organizer's extracted source directory." }
  $env:QGIS_DATA_ROOT = (Resolve-Path -LiteralPath $sourceRoot).Path
}

foreach ($requiredPath in @(
  (Join-Path $env:QGIS_BIN "ogr2ogr.exe"),
  (Join-Path $env:QGIS_BIN "ogrinfo.exe"),
  $env:GDAL_DATA,
  (Join-Path $env:PROJ_DATA "proj.db"),
  (Join-Path $env:QGIS_DATA_ROOT "Data1"),
  (Join-Path $env:QGIS_DATA_ROOT "Data2")
)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) { throw "Missing prerequisite: $requiredPath" }
}

& (Join-Path $env:QGIS_BIN "ogr2ogr.exe") --version
if ($LASTEXITCODE -ne 0) { throw "GDAL cannot run." }
& (Join-Path $env:QGIS_BIN "ogrinfo.exe") --version
if ($LASTEXITCODE -ne 0) { throw "GDAL inspection tool cannot run." }

# Keep complete working data in the ignored directory.
New-Item -ItemType Directory -Path ".\data\extracted" -Force | Out-Null

# Stage this file later, after the asset catalog has been built.
$upstreamSource = Join-Path $env:QGIS_DATA_ROOT "Matched_Upstream\matched_upstream.txt"
if (-not (Test-Path -LiteralPath $upstreamSource)) { throw "Missing upstream source: $upstreamSource" }
```

`scripts/dataBuildScripts/export-remaining-layers.js` uses `QGIS_BIN` and `QGIS_DATA_ROOT`. The other GDAL variables configure the native tools it launches. No permanent PATH change is required.

The existing `public/data/customers.json` was reused for this build and is required by the relationship scripts. If it is absent, generate it after dependency installation and source configuration:

```powershell
if (-not (Test-Path -LiteralPath ".\public\data\customers.json")) {
  npm.cmd run data:customers -- (Join-Path $env:QGIS_DATA_ROOT "Data1\Customer_Clip")
  if ($LASTEXITCODE -ne 0) { throw "Customer-data build failed." }
}
```

### 5. Create the three prerequisite exports

Export these three layers before running the remaining-layer batch script. Use GeoJSON, EPSG:4326, XY geometry without elevation, all features, and all original attribute fields.

| Source | Output under `data/extracted/` | Expected features |
|---|---|---:|
| Data2 / Transformer_Clip | transformers.geojson | 26,959 |
| Data2 / Recloser_Bank_Clip | reclosers.geojson | 331 |
| Data1 / Fuse_Bank_Clip | fuses.geojson | 7,616 |

Keep text identifiers such as `location_n` and `circuit_id` as text. The source `id` fields may be numeric; relationship scripts normalize those identifiers to strings.

Run this PowerShell block to perform and verify the exports without opening QGIS. It checks counts and original field names before replacing each output. GDAL metadata is parsed with Node: Windows PowerShell 5.1's `ConvertFrom-Json` failed on GDAL metadata containing an empty property name during the local run.

```powershell
@'
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

const ogr2ogr = join(process.env.QGIS_BIN, "ogr2ogr.exe");
const ogrinfo = join(process.env.QGIS_BIN, "ogrinfo.exe");
const outputDir = resolve("data/extracted");

// Read one layer's metadata without loading all features into memory.
function inspect(path) {
  const metadata = JSON.parse(execFileSync(
    ogrinfo, ["-ro", "-so", "-al", "-json", path],
    { encoding: "utf8", windowsHide: true },
  ));
  assert.equal(metadata.layers.length, 1);
  return metadata.layers[0];
}

for (const [folder, sourceName, name, expected] of [
  ["Data2", "Transformer_Clip", "transformers", 26959],
  ["Data2", "Recloser_Bank_Clip", "reclosers", 331],
  ["Data1", "Fuse_Bank_Clip", "fuses", 7616],
]) {
  for (const extension of ["shp", "shx", "dbf", "prj"]) {
    await access(join(process.env.QGIS_DATA_ROOT, folder, `${sourceName}.${extension}`));
  }
  const input = join(process.env.QGIS_DATA_ROOT, folder, `${sourceName}.shp`);
  const output = join(outputDir, `${name}.geojson`);
  const temporary = join(outputDir, `.${name}-${randomUUID()}.geojson`);
  const original = inspect(input);
  try {
    execFileSync(ogr2ogr, [
      "-f", "GeoJSON", temporary, input, "-nln", name,
      "-t_srs", "EPSG:4326", "-dim", "XY", "-lco", "RFC7946=YES",
    ], { stdio: "inherit", windowsHide: true });
    const exported = inspect(temporary);
    assert.equal(exported.featureCount, expected);
    assert.equal(exported.featureCount, original.featureCount);
    const fields = new Set(exported.fields.map(field => field.name));
    assert.deepEqual(original.fields.filter(field => !fields.has(field.name)), []);
    await rename(temporary, output);
    console.log(`Exported ${name}: ${exported.featureCount} features; all source fields retained.`);
  } finally {
    await rm(temporary, { force: true });
  }
}
'@ | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw "Prerequisite export or validation failed." }
```

The remaining seven layers are exported by the batch script. It retains attribute names, converts coordinates, checks counts against the inputs, and writes `export-manifest.json`.

## 6. Build the map asset inventory

This is the shortest route for teammates who need the normalized GIS inventory and circuit-reference lookup:

```powershell
# Export primary/secondary lines, switches, poles, damage, fire, and ambulance data.
node scripts/dataBuildScripts/export-remaining-layers.js
if ($LASTEXITCODE -ne 0) { throw "Remaining-layer export failed." }

# Normalize the seven utility-asset layers and build their circuit lookup.
# The filename uses "assets" in the plural.
node scripts/dataBuildScripts/build-assets-catalog.js
if ($LASTEXITCODE -ne 0) { throw "Asset-catalog build failed." }
```

Expected inventory totals:

Skip checking the total if running the README via AI
| Metric | Expected |
|---|---:|
| Utility-asset features | 333,010 |
| Assets without a supplied circuit assignment | 107,013 |
| Distinct raw circuit IDs | 121 |
| Observed circuit references | 135 |
| Raw circuit IDs with multiple observations | 14 |

The 107,013 unassigned assets are poles. They must not acquire a circuit through an unvalidated nearest-neighbor assumption.

```text
data/extracted/normalized/
  manifest.json
  circuits.json
  assets/
    transformers.geojson
    reclosers.geojson
    fuses.geojson
    switches.geojson
    poles.geojson
    primary-lines.geojson
    secondary-lines.geojson
```

Manifest file paths are relative to `data/extracted/normalized/`. Each asset is a GeoJSON Feature with its original exported geometry and these shared fields:

| Field | Meaning |
|---|---|
| `feature.id` | Layer-qualified inventory identity |
| `properties.assetType` | Transformer, recloser bank, fuse, switch, pole, or line type |
| `properties.entityKey` | Original source-table/source-ID identity for relationship joins |
| `properties.sourceLayer`, `sourceTable`, `sourceId` | Internal provenance |
| `properties.circuitRef` | Observed raw-ID/substation/label combination; nullable |
| `properties.circuitId` | Original raw circuit ID; not sufficient for cross-layer merging |
| `properties.locationRef`, `locationRef2`, `upstreamRef` | Source references, without an inferred flow direction |
| `properties.inventoryStatus`, `normalState` | Inventory/normal configuration, not live outage status |

### Circuit-reference limitation

Fourteen raw circuit IDs have different station/label combinations in point equipment and line data. `circuits.json` preserves each correlated observation, its supporting source layers, and review flags. Its `byRawId` lookup can return multiple references.

Use `circuitRef` when grouping normalized asset observations. Do not treat the 135 observed references as 135 verified physical circuits, or merge point and line observations solely because their raw `circuitId` values match. Resolving these cross-layer aliases remains part of the final data integration.

## 7. Build the detailed network relationships

These additional outputs support premise-to-equipment queries and data-quality review. Stage the original upstream TXT once:

```powershell
# Copy the organizer's original file into the ignored working directory.
Copy-Item -LiteralPath $upstreamSource -Destination ".\data\extracted\matched_upstream.txt"

# Verify the staged file matches its original exactly.
$sourceHash = (Get-FileHash -LiteralPath $upstreamSource -Algorithm SHA256).Hash
$copiedHash = (Get-FileHash -LiteralPath ".\data\extracted\matched_upstream.txt" -Algorithm SHA256).Hash
if ($sourceHash -ne $copiedHash) { throw "The upstream source copy does not match." }
```

Then run:

```powershell
# Preserve all ordered equipment hops for every upstream premise.
node scripts/dataBuildScripts/build-upstream.js
if ($LASTEXITCODE -ne 0) { throw "Upstream build failed." }

# Generate the customer/transformer and customer/upstream validation reports.
node scripts/dataBuildScripts/validate-transformer-links.js
if ($LASTEXITCODE -ne 0) { throw "Transformer-link validation failed." }
node scripts/dataBuildScripts/validate-upstream-links.js
if ($LASTEXITCODE -ne 0) { throw "Upstream-link validation failed." }

# Retain customer, upstream-transformer, and GIS references separately.
node scripts/dataBuildScripts/build-customer-network.js
if ($LASTEXITCODE -ne 0) { throw "Customer-network build failed." }

# Build provisional recloser-bank candidates and per-premise circuit checks.
node scripts/dataBuildScripts/build-recloser-crosswalk.js
if ($LASTEXITCODE -ne 0) { throw "Recloser crosswalk build failed." }

# Join fuse identities and check location, equipment type, and customer circuit.
node scripts/dataBuildScripts/build-fuse-links.js
if ($LASTEXITCODE -ne 0) { throw "Fuse-link build failed." }
```

The original source geometry stays in the GIS exports. Full upstream chains stay in `upstream-by-premise.json`; relationship outputs use the same premise IDs and source entity identities.

| Output | Contents |
|---|---|
| upstream-by-premise.json | 117,599 ordered chains / 490,090 hop references |
| customer-network.json | Every customer plus source-specific transformer references and checks |
| recloser-crosswalk.json | Location/type candidates between individual devices and GIS assemblies |
| recloser-links-by-premise.json | Recloser-hop candidates and customer-circuit context |
| fuse-links-by-premise.json | Identity-based fuse links and per-reference checks |
| *exceptions.json and *report.json | Summary counts and unresolved/conflicting records |

Recloser `unique_candidate` is a provisional location/type match, not a verified individual-device/assembly identity. Fuse and transformer identity joins use source table plus ID. Keep unresolved and conflicting records; do not replace them automatically with nearby equipment.

## 8. Verify the completed build

The completed local run matched the inventory totals above, produced 117,599 upstream chains with 490,090 hops, and covered all 117,642 customers in `customer-network.json`. Its exception reports contained 88 customer-network records, 2 recloser crosswalk records, 155 recloser circuit references, and 4,568 fuse references needing review. These are retained data-quality findings, not build failures.

The following checks read generated files without changing them. Exception counts are observations from this source package and can differ when source data changes.

```powershell
@'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load a generated JSON file for a verification check.
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const root = "data/extracted";
const normalized = join(root, "normalized");
const manifest = readJson(join(normalized, "manifest.json"));
assert.equal(manifest.assetCount, 333010);
assert.equal(manifest.assetsWithoutCircuit, 107013);
assert.equal(manifest.rawCircuitIds, 121);
assert.equal(manifest.circuitReferences, 135);
assert.equal(manifest.rawCircuitIdsRequiringReview, 14);

let assetCount = 0;
for (const layer of manifest.layers) {
  const data = readJson(join(normalized, layer.file));
  assert.equal(data.features.length, layer.features);
  assetCount += data.features.length;
}
assert.equal(assetCount, manifest.assetCount);
const circuits = readJson(join(normalized, manifest.circuitsFile));
assert.equal(circuits.records.length, manifest.circuitReferences);
assert.equal(circuits.reviewRawIds.length, manifest.rawCircuitIdsRequiringReview);

const upstream = readJson(join(root, "upstream-by-premise.json"));
assert.equal(Object.keys(upstream.byPremise).length, 117599);
assert.equal(upstream.premiseCount, 117599);
assert.equal(Object.values(upstream.byPremise).reduce((sum, chain) => sum + chain.length, 0), 490090);
assert.equal(upstream.hopCount, 490090);

const customers = readJson("public/data/customers.json");
const network = readJson(join(root, "customer-network.json"));
assert.equal(Object.keys(network.byPremise).length, customers.rows.length);
assert.equal(network.summary.customers, customers.rows.length);
const exceptions = readJson(join(root, "customer-network-exceptions.json"));
assert.equal(exceptions.records.length, customers.rows.length - network.summary.consistent);
for (const filename of [
  "transformer-link-report.json", "upstream-link-report.json",
  "recloser-crosswalk.json", "recloser-crosswalk-exceptions.json",
  "recloser-links-by-premise.json", "recloser-circuit-exceptions.json",
  "fuse-links-by-premise.json", "fuse-link-exceptions.json",
]) {
  readJson(join(root, filename));
}
console.log("Inventory counts, upstream counts, customer coverage, and report files passed.");
'@ | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw "Generated-data verification failed." }

# Working outputs must remain ignored by Git.
foreach ($workingFile in @(
  "data/extracted/export-manifest.json",
  "data/extracted/normalized/manifest.json",
  "data/extracted/customer-network.json"
)) {
  git check-ignore $workingFile
  if ($LASTEXITCODE -ne 0) { throw "Working file is not ignored: $workingFile" }
}
```

## 9. Restart the application

Restart the dev server that was stopped before `npm.cmd ci`:

```powershell
npm.cmd run dev
```

If it was running without a terminal, the local run used a hidden background process instead. Use this **instead of** the foreground command, from a free terminal, when port 5173 is available:

```powershell
$projectPath = (Get-Location).Path
$viteEntry = Join-Path $projectPath "node_modules\vite\bin\vite.js"
$viteArguments = @(('"' + $viteEntry + '"'), "--host", "localhost", "--port", "5173", "--strictPort")
$viteTask = Start-Process -FilePath (Get-Command node).Source -ArgumentList $viteArguments -WorkingDirectory $projectPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectPath "data\extracted\.vite-dev.stdout.log") -RedirectStandardError (Join-Path $projectPath "data\extracted\.vite-dev.stderr.log") -PassThru
Write-Output "Dev server PID: $($viteTask.Id); URL: http://localhost:5173/map.html"
```

Wait for Vite to report that it is ready. The background command writes its startup messages and any errors to the two ignored log files above. Open `http://localhost:5173/map.html` and confirm the map loads.

## Accessing data in code

### Node, build scripts, or a future backend

These processes can read the local files directly. For example, run this code from the repository root in a Node module:

```js
// Import Node's local file reader.
import { readFile } from "node:fs/promises";

// Read the small manifest to discover available asset files.
const root = "data/extracted/normalized";
const manifest = JSON.parse(
  await readFile(`${root}/manifest.json`, "utf8"),
);

// Find the requested layer using its documented name.
const layer = manifest.layers.find((item) => item.layer === "transformers");
if (!layer) throw new Error("Transformer layer is absent from the manifest.");

// Load only that layer, rather than all 333,010 asset features.
const transformers = JSON.parse(
  await readFile(`${root}/${layer.file}`, "utf8"),
);

// GeoJSON features expose geometry plus the shared properties described above.
console.log(transformers.features.length);
```

### Browser code such as src/map.js

The normalized working files are not currently served at a public application URL. Browser code cannot use `node:fs`, and committing the scripts does not make ignored files available through `fetch()`.

The application handoff still needs one of these delivery mechanisms:

1. A reviewed public export containing only approved map geometry and attributes, served from `public/data/`; or
2. A backend API that reads the internal files and returns approved subsets.

For a future static export, the browser pattern would be:

```js
// Example future browser URL: the current pipeline does not create it yet.
const response = await fetch("/data/network/assets/transformers.geojson");

// Reject failed requests before trying to parse their contents.
if (!response.ok) throw new Error("Could not load transformer map data.");

// GeoJsonLayer can render this FeatureCollection once the endpoint exists.
const transformers = await response.json();
```

Do not copy the entire internal working directory into `public/`. Internal files contain source IDs, detailed relationships, and precise coordinates. Removing a field from a popup does not remove it from a downloaded JSON file. The existing `public/data/customers.json` also needs review before describing the deployed application as anonymized.

## Remaining integration work

- Normalize damage reports and emergency-facility context into their own collections. They are not utility assets and lack the same electrical-service keys.
- Resolve or explicitly retain the source-context circuit ambiguities when connecting damage, line, and customer records.
- Define and implement the approved browser export or backend API, plus the map team's loading interface.
- Keep exact sensitive locations, premise identifiers, medical flags, and internal-only operational fields out of unrestricted customer-facing outputs.
- Add a single pipeline command after the required source staging and final outputs are settled.

Repair-time estimation and AI recommendations are separate features. The current pipeline retains useful source evidence for them but does not implement those models.
