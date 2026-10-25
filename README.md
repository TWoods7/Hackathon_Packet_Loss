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
    scripts/
    public/data/customers.json
    data/extracted/
```

Run the commands below from the repository root. If PowerShell cannot find an installation at the standard Node location:

```powershell
# Add the installed Node directory to this terminal session's search path.
$env:Path = "C:\Program Files\nodejs;" + $env:Path

# Check that Node is available.
node --version

# Install the existing application's dependencies.
npm.cmd ci
```

`scripts/export-remaining-layers.js` supports `QGIS_BIN` and `QGIS_DATA_ROOT` environment overrides. Set these to real local paths if the defaults differ on your computer; no permanent PATH change is required for the GDAL tools.

### Initial working exports

Create `data/extracted/` and export these three QGIS layers there. Use GeoJSON, EPSG:4326, XY geometry without elevation, all features, and all original attribute fields.

| Source | Output under `data/extracted/` | Expected features |
|---|---|---:|
| Data2 / Transformer_Clip | transformers.geojson | 26,959 |
| Data2 / Recloser_Bank_Clip | reclosers.geojson | 331 |
| Data1 / Fuse_Bank_Clip | fuses.geojson | 7,616 |

Keep text identifiers such as `location_n` and `circuit_id` as text. The source `id` fields may be numeric; relationship scripts normalize those identifiers to strings.

The remaining seven layers are exported by the batch script. It retains attribute names, converts coordinates, checks counts against the inputs, and writes `export-manifest.json`.

## Build the map asset inventory

This is the shortest route for teammates who need the normalized GIS inventory and circuit-reference lookup:

```powershell
# Export primary/secondary lines, switches, poles, damage, fire, and ambulance data.
node scripts/export-remaining-layers.js

# Normalize the seven utility-asset layers and build their circuit lookup.
# The filename uses "assets" in the plural.
node scripts/build-assets-catalog.js
```

Expected inventory totals:

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

## Build the detailed network relationships

These additional outputs support premise-to-equipment queries and data-quality review. Stage the original upstream TXT once:

```powershell
# Copy the organizer's original file into the ignored working directory.
Copy-Item -LiteralPath "..\Hackathon Data\Matched_Upstream\matched_upstream.txt" -Destination ".\data\extracted\matched_upstream.txt"
```

Then run:

```powershell
# Preserve all ordered equipment hops for every upstream premise.
node scripts/build-upstream.js

# Generate the customer/transformer and customer/upstream validation reports.
node scripts/validate-transformer-links.js
node scripts/validate-upstream-links.js

# Retain customer, upstream-transformer, and GIS references separately.
node scripts/build-customer-network.js

# Build provisional recloser-bank candidates and per-premise circuit checks.
node scripts/build-recloser-crosswalk.js

# Join fuse identities and check location, equipment type, and customer circuit.
node scripts/build-fuse-links.js
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
