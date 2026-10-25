# Packet Loss

Packet Loss is a HackOHIO 2026 outage-concierge prototype built with JavaScript, Vite, Google Maps, and deck.gl. It displays customer locations, estimates outage areas from the challenge's damage and network data, and lets users look up an address near the service area in southwest Virginia.

**A fresh clone includes the data needed to run the current map.** You need Node.js, npm, and a Google Maps API key. You do not need QGIS, another developer's QGIS project, or a local `data/extracted/` directory to run the app.

## Current features

- Customer markers grouped by overhead, underground, and unknown service, with a separate life-support layer.
- Simulated customers without power and unrepaired-damage markers.
- Clickable outage boundaries with affected-customer counts, damage summaries, and estimated repair effort in crew-hours.
- Address search that highlights the nearest customer node and describes its simulated power status.
- A chat interface with a placeholder response. It is not connected to an AI service yet.

Outages come from the supplied damage snapshot, not a live utility feed. Repair effort is a labor estimate, not a promised restoration time. Address search uses the nearest customer as a proxy; it does not verify that an address belongs to that service account.

## Run after cloning

### 1. Clone and install dependencies

Install Git and Node.js with npm. Node 24 was used for local development. Run these commands in a terminal:

```sh
# Download the project and enter its root directory.
git clone https://github.com/TWoods7/Hackathon_Packet_Loss.git
cd Hackathon_Packet_Loss

# Check that Node and npm are available, then install the locked dependencies.
node --version
npm --version
npm ci
```

If you have already cloned the repository, start from its root directory and run `npm ci`. On Windows PowerShell, use `npm.cmd` in place of `npm` if PowerShell blocks `npm.ps1`.

### 2. Configure Google Maps

Create a `.env` file in the repository root by copying `.env.example`.

PowerShell:

```powershell
# Create a local configuration file on a fresh clone.
Copy-Item .env.example .env
```

macOS/Linux:

```sh
# Create a local configuration file on a fresh clone.
cp .env.example .env
```

Edit `.env` and replace the placeholder:

```dotenv
# Browser API key used to load Google Maps and search addresses.
VITE_GOOGLE_MAPS_API_KEY=your_actual_google_maps_key
```

Use a Google Cloud project with the **Maps JavaScript API** and **Geocoding API** enabled. Follow Google's [Maps setup guide](https://developers.google.com/maps/documentation/javascript/get-api-key) and [Geocoding setup guide](https://developers.google.com/maps/documentation/javascript/geocoding) for account, billing, and API configuration. Configure website restrictions for your development URL, such as `http://localhost:5173/*`, and your deployment URL when applicable.

`.env` is ignored by Git, so each teammate must configure it locally. Vite includes `VITE_` variables in browser code; this Maps key is a browser credential. Keep server-side secrets out of these variables.

### 3. Start the app

```sh
# Start Vite's local development server.
npm run dev
```

Open the URL printed by Vite, normally:

- Home: `http://localhost:5173/`
- Map: `http://localhost:5173/map.html`

If port 5173 is occupied, Vite may choose another port. Use the printed URL and allow that origin in the Maps key's website restrictions.

On the map, legend checkboxes start unchecked. Enable **Overhead**, **Underground**, **Unknown**, **Life support**, **No power**, or **Damaged equipment** to show those markers. Outage boundaries are displayed independently of these checkboxes. Click a boundary for its details. After searching an address, enable **Nearest to you** to show the address-to-customer connection.

Restart the development server after changing `.env`.

## Available commands

Run commands from the repository root.

| Command | Purpose | Requires extracted working data? |
|---|---|---|
| `npm ci` | Install dependencies from `package-lock.json` | No |
| `npm run dev` | Run the development server | No |
| `npm run build` | Build both HTML pages into `dist/` | No |
| `npm run preview` | Serve the existing production build locally | No |
| `npm run data:customers -- "path/to/Customer_Clip"` | Replace the customer JSON from a shapefile basename, without `.shp` | Yes: customer source files |
| `npm run data:grid` | Replace the browser outage grid from working GIS/network files | Yes |

To check the production build:

```sh
# Compile the app, then serve the generated files locally.
npm run build
npm run preview
```

Open the preview URL printed in the terminal, followed by `/map.html`. The Maps key must allow that origin too. The key is read when building, so changing it requires another build. The project has no automated test command configured.

## Project layout

```text
.env.example                  Maps configuration template
index.html                    Landing page
map.html                      Map, search, legend, and chat markup
src/
  map.js                      Map layers, address search, and outage panels
  outages.js                  Grid loader and outage calculations
  chatbot.js                  Chat panel with placeholder replies
  style.css                   Shared styling and map colors
public/data/                  Tracked files served at /data/...
scripts/
  boundingAlgorithm.js        Convex-hull boundary layers used by the map
  dataBuildScripts/           Customer, GIS, relationship, and grid builders
vite.config.js                Build configuration for both HTML pages
```

There is currently no backend server or hosted database. Data is stored as JSON and GeoJSON files.

## Data included in a clone

| Tracked file | Role in the current project |
|---|---|
| `public/data/customers.json` | Customer locations, service categories, and source references; loaded by the map |
| `public/data/grid.json` | Devices, customer device chains, damage, and simulation candidates; loaded by the map |
| `public/data/labor.json` | Labor reference values and team repair recipes; used when rebuilding the grid |
| `public/data/hospitals.geojson` | Hospital export; the current map does not load a hospital layer |
| `public/data/hospitals.qmd` | QGIS metadata accompanying the hospital export |
| `public/data/testData.js` | Sample boundary data; not imported by the current map |

The current snapshot contains 117,642 customer rows. The grid contains a device chain entry for each row, including an empty chain when upstream data is missing.

Git does **not** include `.env`, `node_modules/`, `dist/`, or `data/extracted/`. The original QGIS project and organizer source package are also not bundled with this repository. Missing extracted files do not prevent the committed map data from loading.

Files in `public/` are downloadable by anyone who can access the running application. The current customer file includes premise identifiers, location information, transformer references, and life-support flags. The app is a team prototype; its current datasets and popups have not been reduced to an anonymized customer-facing export.

## How the map uses the data

`src/map.js` fetches `/data/customers.json`. `src/outages.js` fetches `/data/grid.json`. Vite serves those URLs from `public/data/` during development and copies the files into the production build.

Customer, device, and damage tables use a compact `{ fields, rows }` format: the field at position `i` names the value at position `i` in each row. The loaders convert these rows into objects.

**Customer ordering must stay synchronized:** `grid.customerChains[i]` belongs to `customers.rows[i]`. If you regenerate, filter, or reorder the customer file, rebuild the grid and share both files together. Replacing only one can associate outages with the wrong locations.

For the simulation, unrepaired damage trips associated devices. A customer is marked without power when a device in its upstream chain is tripped. Customers are grouped under their most upstream tripped device, and the map draws a convex hull around each group's locations. Very small groups may have no polygon. These hulls are visual summaries, not surveyed electrical-service boundaries.

Crew-hours are calculated from damage labor recipes and the indirect labor multiplier. They do not account for a complete crew schedule, resource availability, or an actual restoration deadline. Some damage-to-network links use spatial fallbacks; `grid.json` retains a `traceMethod` for inspecting those assumptions.

When adding features in a module under `src/`, reuse the outage functions:

```js
// Import the existing grid loader and simulation helpers.
import { loadGrid, trippedDevices, computeOutages } from "./outages.js";

// Load the committed browser grid and unpack its tables.
const grid = await loadGrid();

// Identify devices associated with the snapshot's unrepaired damage.
const tripped = trippedDevices(grid.damages);

// Calculate customer power masks and outage groups using the same model as the map.
const result = computeOutages(grid, tripped, grid.damages);

// Customer indices in these groups refer to customers.json row positions.
console.log(result.zones.length);
```

Browser modules use `fetch()` for served data. Node build scripts can read local working files with `node:fs`. The app does not currently load the normalized asset catalog under `data/extracted/normalized/`; creating that catalog alone does not add a map layer.

## Optional: change or rebuild the datasets

Skip this section to work on the current interface or map using the committed snapshot. `npm ci` and `npm run build` do not run the data pipeline.

### Use the team's extracted data

Obtain the team's working-data copy through the agreed private sharing method. If it includes a manifest and verification instructions, verify the copy before using it. Restore its `data/extracted/` contents under this repository's root, preserving filenames and subdirectories. An already exported JSON/GeoJSON copy does not require access to another developer's QGIS installation.

The grid builder needs these files, plus the tracked `public/data/customers.json` and `public/data/labor.json`:

```text
data/extracted/
  upstream-by-premise.json
  recloser-crosswalk.json
  transformers.geojson
  reclosers.geojson
  fuses.geojson
  switches.geojson
  poles.geojson
  primary-lines.geojson
  secondary-lines.geojson
  damage.geojson
```

Use the customer snapshot that matches those working files. Once the inputs are present:

```sh
# Replace the browser grid using the matching working data and customer rows.
npm run data:grid
```

This command can use substantial memory; the package script allows Node up to 8 GiB of heap. It overwrites `public/data/grid.json`. Review the resulting change before committing it.

If changing the customer source, the customer builder reads `.shp` and `.dbf` files from the supplied basename. It reads coordinates directly, so the input must already use longitude/latitude. It does not reproject coordinates. Regenerate the grid after changing customers.

### Rebuild from the original GIS sources

Obtain the organizer's source package, including shapefile companion files and `matched_upstream.txt`. For GIS exports, use QGIS/GDAL. The batch exporter is configured for Windows and accepts `QGIS_BIN` and `QGIS_DATA_ROOT` environment variables; its defaults are QGIS 3.44.15's `bin` directory and a `Hackathon Data` folder beside this repository, containing `Data1/` and `Data2/`. Configure GDAL/PROJ resources for your installation as needed.

Create `data/extracted/` and export these prerequisites with all features and original attribute fields, EPSG:4326 coordinates, and XY geometry:

| Source layer | Output filename | Features in the original snapshot |
|---|---|---:|
| `Data2/Transformer_Clip` | `transformers.geojson` | 26,959 |
| `Data2/Recloser_Bank_Clip` | `reclosers.geojson` | 331 |
| `Data1/Fuse_Bank_Clip` | `fuses.geojson` | 7,616 |

Copy the supplied upstream TXT to `data/extracted/matched_upstream.txt`. The tracked customer snapshot can be reused when it matches the same source package. Then run the pipeline from the repository root, stopping to resolve any failed command:

```sh
# Export the seven remaining GIS layers and validate their counts.
node scripts/dataBuildScripts/export-remaining-layers.js

# Parse ordered upstream chains and validate their customer/transformer links.
node scripts/dataBuildScripts/build-upstream.js
node scripts/dataBuildScripts/validate-transformer-links.js
node scripts/dataBuildScripts/validate-upstream-links.js

# Build customer relationships and equipment crosswalks, retaining exceptions.
node scripts/dataBuildScripts/build-customer-network.js
node scripts/dataBuildScripts/build-recloser-crosswalk.js
node scripts/dataBuildScripts/build-fuse-links.js

# Create the separate normalized asset inventory and circuit-reference lookup.
node scripts/dataBuildScripts/build-assets-catalog.js

# Generate the browser grid consumed by the current map.
npm run data:grid
```

Review the generated manifests, counts, and exception reports. The normalized catalog preserves observed circuit references; differing source station/label combinations are not automatically verified aliases. Recloser crosswalk candidates and spatial matches also require interpretation. Exported fire and ambulance stations and the normalized inventory are not automatically displayed by `src/map.js`.

Working outputs remain ignored under `data/extracted/`. Share approved updates to the browser snapshot through Git; share internal working data separately. Keep `customers.json` and `grid.json` from the same build together.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `node` or `npm` is not recognized | Install Node.js with npm, reopen the terminal, and check `node --version`. On Windows, confirm the Node installation directory is on PATH. |
| PowerShell blocks `npm.ps1` | Use `npm.cmd ci` or `npm.cmd run dev`; changing script policy is unnecessary. |
| Missing Google Maps key message | Set `VITE_GOOGLE_MAPS_API_KEY` in root `.env`, then restart Vite. |
| Google Maps authorization or address-search errors | Check the browser console, enabled APIs, key restrictions, and Google Cloud account configuration. |
| Map loads but customer or damage markers are absent | Enable the corresponding legend checkboxes; they start unchecked. |
| Missing `customers.json` or `grid.json` | Restore the tracked files from the intended branch/commit. Rebuilding requires the additional inputs above. |
| `ENOENT` while running a data script | Run it from the repository root and check that its extracted input files have been restored. |
| `npm ci` fails with Windows file-lock errors | Stop this project's dev/preview server with Ctrl+C, then retry. |
| Chat replies say the assistant is not connected | Expected: `src/chatbot.js` currently returns a placeholder reply. |
