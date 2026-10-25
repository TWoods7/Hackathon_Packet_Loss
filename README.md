# Packet Loss

Packet Loss's **Chat AEP** is a HackOHIO 2026 outage-concierge prototype built with JavaScript, Vite, Google Maps, and deck.gl. It displays customer locations, estimates outage areas from the challenge's damage and network data, and lets users look up an address near the service area in southwest Virginia.

**A fresh clone includes the data needed to run the current map.** You need Node.js, npm, and a Google Maps API key. You do not need QGIS, another developer's QGIS project, or a local `data/extracted/` directory to run the app.

## Current features

- Customer markers grouped by overhead, underground, and unknown service, with a separate life-support layer.
- Simulated customers without power and unrepaired-damage markers.
- Clickable outage boundaries with affected-customer counts, damage summaries, and estimated repair effort in crew-hours.
- Address search that highlights the nearest customer node and describes its simulated power status.
- An Outage Assistant chatbot (Claude Sonnet 5.5 with tool calls). Searching an address, street, or area switches to a full-page chat with a short summary, where you can ask follow-up questions. A large **Back to map** button (or the browser's Back button) returns to the map. It searches your address, forecasts outage risk, estimates a restoration range, checks alert eligibility, drafts notifications, and can move the map's storm slider. See [Outage Assistant](#outage-assistant).

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

To enable the chatbot, also set a server-only Anthropic API key in `.env`:

```dotenv
# Used only by the dev server's /api/chat route; no VITE_ prefix, so it never reaches the browser.
ANTHROPIC_API_KEY=your_anthropic_key
```

### 3. Start the app

```sh
# Start Vite's local development server.
npm run dev
```

Open the URL printed by Vite, normally `http://localhost:5173/`. The app is a single page: the map, and the chat that opens when you search a location.

If port 5173 is occupied, Vite may choose another port. Use the printed URL and allow that origin in the Maps key's website restrictions.

On the map, legend checkboxes start unchecked. Enable **Overhead**, **Underground**, **Unknown**, **Life support**, **No power**, or **Damaged equipment** to show those markers. Outage boundaries are displayed independently of these checkboxes. Click a boundary for its details. After searching an address, enable **Nearest to you** to show the address-to-customer connection.

Restart the development server after changing `.env`.

## Outage Assistant

Searching a location opens the full-page chat view (`map.js` fires a `location-searched` event that `chatbot.js` turns into a summary request). The chat covers the map instead of replacing it, so the map stays loaded and the assistant's tools keep working on it. It talks to `/api/chat`, a route the Vite dev and preview servers add (`server/chat.js`). The server adds the system prompt and tool definitions (`server/prompt.js`) and relays one turn at a time to Claude. When Claude calls a tool, the browser runs it against the live map state (`src/assistantTools.js`), then sends the result back. This means the chat and the map always agree.

- **Prompting:** the system prompt holds the rules, the alert rules, the message templates, and one worked example that walks through the steps (look up the address, set the storm, get the risk, get the range) before the answer. Claude ends each prediction with a plain-language `<explanation>` of the data and assumptions behind it, which the chat shows collapsed under "How I got this". Claude's own thinking stays internal: asking it to print its reasoning trips the API's `reasoning_extraction` safety check.
- **Tools:** `search_address`, `get_current_status`, `set_storm_severity`, `get_outage_risk`, `estimate_restoration` (crews and access are scenario inputs), and `check_alert_eligibility`. All numbers come from `src/restorationModel.js`.
- **Privacy and safety:** tool results never include premise IDs, coordinates, device IDs, or life-support flags. The server accepts only user and assistant turns, so the browser can't change the system prompt. The server log records tool names and token counts, never message text. Low-confidence locations get an explicit fallback message.

`npm run build` output has no `/api/chat` route. Use `npm run preview` (or add a small Node server) to keep the chatbot working after a build.

## Available commands

Run commands from the repository root.

| Command | Purpose | Requires extracted working data? |
|---|---|---|
| `npm ci` | Install dependencies from `package-lock.json` | No |
| `npm run dev` | Run the development server | No |
| `npm run build` | Build both HTML pages into `dist/` | No |
| `npm run preview` | Serve the existing production build locally | No |
| `npm run data:customers -- "path/to/Customer_Clip"` | Replace the private full customer file `data/extracted/customers.json` from a shapefile basename, without `.shp`; run `npm run data:grid` afterwards to refresh the public files | Yes: customer source files |
| `npm run data:grid` | Replace the browser outage grid from working GIS/network files | Yes |

To check the production build:

```sh
# Compile the app, then serve the generated files locally.
npm run build
npm run preview
```

Open the preview URL printed in the terminal. The Maps key must allow that origin too. The key is read when building, so changing it requires another build. The project has no automated test command configured.

## Project layout

```text
.env.example                  Maps configuration template
AGENTS.md                     Rules for coding agents (Codex, Claude): data privacy and file alignment
index.html                    The app page: map, search, legend, storm slider, and chat markup
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
| `public/data/customers.json` | Customer locations only (`lng`, `lat`, rounded to about 11 m); loaded by the map. Written by `npm run data:grid` |
| `public/data/grid.json` | Devices, customer device chains, damage, and simulation candidates; loaded by the map |
| `public/data/labor.json` | Labor reference values and team repair recipes; used when rebuilding the grid |
| `public/data/hospitals.geojson` | Hospital export; the current map does not load a hospital layer |

The current snapshot contains 117,642 customer rows. The grid contains a device chain entry for each row, including an empty chain when upstream data is missing.

Git does **not** include `.env`, `node_modules/`, `dist/`, or `data/extracted/`. The original QGIS project and organizer source package are also not bundled with this repository. Missing extracted files do not prevent the committed map data from loading.

Files in `public/` are downloadable by anyone who can access the running application, so they hold only what the map needs. The public customer file has rounded locations and nothing else: premise identifiers, transformer references, circuit IDs, street names, and life-support flags stay in the full file at `data/extracted/customers.json`, which Git ignores and the build scripts read. Map popups and panels don't show circuit IDs. Earlier commits did include the full customer file, so it remains in the repository's Git history.

## How the map uses the data

`src/map.js` fetches `/data/customers.json`. `src/outages.js` fetches `/data/grid.json`. Vite serves those URLs from `public/data/` during development and copies the files into the production build.

Customer, device, and damage tables use a compact `{ fields, rows }` format: the field at position `i` names the value at position `i` in each row. The loaders convert these rows into objects.

**Customer ordering must stay synchronized:** `grid.customerChains[i]` belongs to `customers.rows[i]`. `npm run data:grid` writes both public files from the same full customer file, so they stay aligned. If you regenerate, filter, or reorder the full customer file, rerun it and commit both files together. Replacing only one can associate outages with the wrong locations.

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

> **Data layout change (privacy for the demo).** `public/data/customers.json` used to hold every customer field (premise, transformer, circuit, street, life support). It now holds only rounded `lng`/`lat`, because everything in `public/` can be downloaded from the running app. The full file moved to `data/extracted/customers.json` (ignored by Git), and every data script now reads it from there. `npm run data:grid` writes the slim public copy.
>
> If a data script fails with `ENOENT ... data/extracted/customers.json`, or complains that a field such as `premise` or `transformer` is missing, restore the full file from Git history (the last commit that had it), then rerun the script:
>
> ```sh
> # Recreate the private full customer file from before the privacy change.
> mkdir -p data/extracted
> git show a3a4575:public/data/customers.json > data/extracted/customers.json
> ```
>
> Never copy the full file back into `public/data/`. Don't add premise, transformer, circuit, street, or life-support fields to anything under `public/`, or show circuit IDs in the map UI.

Skip this section to work on the current interface or map using the committed snapshot. `npm ci` and `npm run build` do not run the data pipeline.

### Use the team's extracted data

Obtain the team's working-data copy through the agreed private sharing method. If it includes a manifest and verification instructions, verify the copy before using it. Restore its `data/extracted/` contents under this repository's root, preserving filenames and subdirectories. An already exported JSON/GeoJSON copy does not require access to another developer's QGIS installation.

The grid builder needs these files, including the full `customers.json`, plus the tracked `public/data/labor.json`:

```text
data/extracted/
  customers.json
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

Copy the supplied upstream TXT to `data/extracted/matched_upstream.txt`. Build the full customer file with `npm run data:customers` (or restore the team's `data/extracted/customers.json` from the same source package). Then run the pipeline from the repository root, stopping to resolve any failed command:

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
| Missing `customers.json` or `grid.json` | Restore the tracked files in `public/data/` from the intended branch/commit. Rebuilding requires the additional inputs above, including `data/extracted/customers.json`. |
| `ENOENT` while running a data script | Run it from the repository root and check that its extracted input files have been restored. For `data/extracted/customers.json`, see the data layout note in [Optional: change or rebuild the datasets](#optional-change-or-rebuild-the-datasets). |
| A data script says `premise`, `transformer`, or `circuitId` is missing | It is reading the slim public customer file. Data scripts must read `data/extracted/customers.json`; restore it with `git show a3a4575:public/data/customers.json > data/extracted/customers.json`. |
| `npm ci` fails with Windows file-lock errors | Stop this project's dev/preview server with Ctrl+C, then retry. |
| Chat replies say the assistant is not connected | Expected: `src/chatbot.js` currently returns a placeholder reply. |
