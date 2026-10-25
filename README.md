# Packet Loss

Packet Loss's **Chat AEP** is a HackOHIO 2026 outage-concierge prototype built with JavaScript, Vite, Google Maps, and deck.gl. It combines a storm scenario map with an assistant that explains simulated outage risk, repair assumptions, preparation, and alert eligibility for a selected location in southwest Virginia.

**A fresh clone includes the JSON needed to run the current map and storm simulation.** You need Node.js, npm, and a Google Maps API key. The chatbot also needs a server-side Anthropic API key. QGIS and locally extracted GIS data are needed only when rebuilding the datasets.

## Current features

- A storm-strength slider with named levels (calm, thunderstorms, a winter storm, Helene's remnants, up to the February 2025 storms) that generates repeatable damage and outage scenarios.
- Forecast hexagons showing expected hours without power across possible outcomes.
- Simulated damage markers and approximate outage circles, with affected-customer counts, repair-work totals, and upstream-dependent restoration steps.
- Address search that matches the nearest customer node and refreshes its simulated status as the storm level changes.
- An assistant that can change the storm level, read the same active scenario, explain risk, estimate repair ranges, evaluate alert eligibility, and draft customer notifications.
- A **Preview my alerts** button in the chat that shows the four customer messages (before the storm, outage confirmed, estimate updated, power restored) with channels, send timing, escalation triggers, and a checkbox for declaring powered medical equipment.
- **Repair crews** slider and **Roads blocked** checkbox in the storm panel. They change repair times (heatmap, outage-panel steps, search result, assistant ranges, alert messages) but never which equipment fails.
- Confidence levels (high, medium, low) with a plain-language reason: high needs a close address match, recorded storm damage on the customer's lines, and a storm level that matches a real storm in the records.
- Priority locations (hospitals, fire and ambulance stations) restored first, without naming or showing them.
- An instant **safety banner** in the chat for downed lines, sparks, fire, generators, flooding, or medical emergencies, and a **Talk to a person** button that shows the summary a utility agent would receive.

All outage results are model outputs, not live utility information. Address matching uses a nearby customer node as a proxy, not a verified service-account match. Repair ranges use labor and queue assumptions and are not official restoration deadlines or validated confidence intervals. The app drafts notifications; it does not send them.

## Run after cloning

### 1. Install dependencies

Install Git and Node.js with npm. Node 24 was used for development. Run these commands in a terminal:

```sh
# Clone the repository and enter its root directory.
git clone https://github.com/TWoods7/Hackathon_Packet_Loss.git
cd Hackathon_Packet_Loss

# Confirm the tools are available and install the locked dependencies.
node --version
npm --version
npm ci
```

If already cloned, run `npm ci` from the root. Repeat it after pulling dependency changes. In Windows PowerShell, use `npm.cmd` if PowerShell blocks `npm.ps1`. Stop this project's dev/preview server before reinstalling dependencies if Windows reports file locks.

### 2. Configure local keys

Copy `.env.example` to `.env` in the repository root. On a fresh clone, use PowerShell:

```powershell
# Create the local configuration file.
Copy-Item .env.example .env
```

On macOS/Linux, use `cp .env.example .env`. Edit the new file:

```dotenv
# Browser credential for the map and address geocoding.
VITE_GOOGLE_MAPS_API_KEY=your_actual_google_maps_key

# Server-only credential for the assistant; keep the name without VITE_.
ANTHROPIC_API_KEY=your_actual_anthropic_key
```

Enable **Maps JavaScript API** and **Geocoding API** in the Google Cloud project. Follow Google's [Maps setup guide](https://developers.google.com/maps/documentation/javascript/get-api-key) and [Geocoding setup guide](https://developers.google.com/maps/documentation/javascript/geocoding) for account, billing, and API setup. Allow the development origin, such as `http://localhost:5173/*`, in the key's website restrictions and add the deployment origin when needed.

`.env` is ignored by Git; teammates configure it locally. Vite includes `VITE_` variables in browser code, so server credentials must not use that prefix. The Anthropic key is read by the local dev/preview server. The map can run without a working chatbot key, but chat requests will fail until it is configured. The assistant's model is configured in `server/prompt.js`.

### 3. Start the app

```sh
# Run the development server.
npm run dev
```

Open the printed URL, normally `http://localhost:5173/`. Vite may choose another port if 5173 is occupied; allow that origin in the Maps key settings too. The app is one page containing the map and a chat view that opens over it when a location is searched.

The storm starts at **Calm**, generating no new simulated damage or outages. Move the slider to generate an outcome. Use the **Area without power** and **Damaged equipment** buttons beside the address search bar to toggle those layers; the first starts on and the second starts off. Active buttons use the Search button's color with white text; inactive buttons are white with black text. After searching a covered area, the map highlights the nearest node with a yellow circle. If the address is outside all forecast hexagon tiles and more than 300 meters from the nearest node, the map shows **This area is not covered.** and stays on the map. Tile coverage is independent of the storm colors, including in calm weather. Click an outage circle for details. Use **Back to map** to return from chat.

Restart Vite after changing `.env` or the server prompt. Start a fresh conversation when checking revised prompt behavior.

## Commands and production builds

Run commands from the repository root. None of the application commands rebuild GIS data.

| Command | Purpose | Requires extracted working data? |
|---|---|---|
| `npm ci` | Install dependencies from `package-lock.json` | No |
| `npm run dev` | Run Vite with the `/api/chat` route | No |
| `npm run build` | Compile the app page and copy public assets into `dist/` | No |
| `npm run preview` | Serve the existing build with the local chat route | No |
| `node --test` | Check tile coverage and uncovered-location assistant behavior without model requests | No |
| `npm run data:customers -- "path/to/Customer_Clip"` | Replace the private customer JSON from a shapefile basename without `.shp` | Yes: customer source files |
| `npm run data:grid` | Rebuild the public grid and aligned public customer locations, then mark devices that serve priority locations (`add-priority-locations.js`) | Yes |

```sh
# Build the app, then serve the generated output locally.
npm run build
npm run preview
```

Use the preview URL printed by Vite and allow that origin in the Maps key settings. Browser configuration is read at build time; rebuild after changing it. Static hosting of `dist/` alone does not provide `/api/chat`: deployed chat requires a server route equivalent to `server/chat.js`. Run `node --test` for the local coverage checks.

## Project layout

```text
.env.example                  Local configuration template
AGENTS.md                     Data privacy, alignment, and model rules
index.html                    Map, search, legend, storm slider, and chat
src/
  map.js                      Scenario state, rendering, search, and map API
  outages.js                  Grid loading, forecasts, and customer impact
  stormSimulation.js          Seeded sampling of candidate failures
  stormScenario.js            One complete sampled scenario and work totals
  restorationModel.js         Failure-probability and repair-time formulas
  hexGrid.js                  Privacy-aware aggregation into forecast hexagons
  assistantTools.js           Assistant tools reading the active map scenario
  chatbot.js                  Chat view and server/tool request loop
  style.css                   Shared styling and map colors
server/
  chat.js                     Server-side Anthropic request middleware
  prompt.js                   Model selection, instructions, and tool schemas
public/data/                  Tracked browser datasets, served at /data/...
scripts/
  boundingAlgorithm.js        Geometry utility retained from earlier map work
  dataBuildScripts/           GIS, customer, relationship, and grid builders
vite.config.js                App build and dev/preview chat middleware
```

Data is stored as JSON and GeoJSON files rather than a hosted database. The local Vite server supplies the assistant API middleware.

## Data included in a clone

| Tracked file | Role |
|---|---|
| `public/data/customers.json` | Customer longitude/latitude rounded to four decimal places, in grid row order |
| `public/data/grid.json` | Devices, customer chains, failure candidates, labor inputs, historical damage, and calibration metadata |
| `public/data/labor.json` | Labor reference values, indirect multiplier, and team repair recipes |
| `public/data/hospitals.geojson` | Hospital export; read by `add-priority-locations.js` at build time, never loaded by the map |

The current snapshot has 117,642 customer rows. `grid.customerChains[i]` belongs to `customers.rows[i]`; an empty chain means missing upstream data. **Keep the public customer and grid files from the same build together.** `npm run data:grid` writes both from the full private customer file.

Git excludes `.env`, `node_modules/`, `dist/`, and `data/extracted/`. The original QGIS project and source package are not bundled. Their absence does not prevent the committed map and simulation from running.

Everything under `public/` is downloadable. The full customer attributes stay in ignored `data/extracted/customers.json`; the public customer copy contains only rounded coordinates. Device coordinates are omitted from the public grid. The grid still contains the network model and candidate/damage geometry used by the app. Popups and assistant tool results omit internal identifiers. Earlier commits contained full customer data, which remains in Git history. Follow `AGENTS.md` when changing exports or UI fields.

## How the simulation works

`src/map.js` fetches `/data/customers.json`, and `loadGrid()` in `src/outages.js` fetches `/data/grid.json`. Compact tables use `{ fields, rows }`; the loader reconstructs device and historical-damage objects by field name. Vite serves these files during development and includes them in the build.

The active flow is:

1. `prepareForecast(grid)` calculates customer exposure once.
2. The slider picks a level from `src/stormLevels.js`. Each level is an expected number of broken poles and wires, named after real storms in the area's 2022-2026 damage reports (ordinary thunderstorm days break 7-16; the January 2025 winter storm 33; Helene's remnants 157; the February 12-17, 2025 storms 882). `levelSeverity()` turns that into a severity fraction: the share of the worst storm's line damage. The slider is not wind speed or rainfall, and calm includes light rain.
3. `stormForecast()` converts severity into failure probabilities and expected outage hours.
4. `simulateStormDamage()` compares each candidate probability with a seeded random draw. The map uses seed **2026**. Reusing the seed and dataset produces the same outcome, and raising the storm level retains existing failures while adding others. Reordering or rebuilding candidates can change the outcome.
5. `buildStormScenario()` traces generated failures through protective-device chains, groups customers under their most upstream tripped device, and totals repair work. Multiple repairs affecting one device remain separate repair records.
6. `map.js` updates circles, markers, counts, and an existing address result. It refreshes the shared customer-to-outage lookup so assistant tools read the same scenario.

The original historical damage records remain in `grid.damages`; the current map displays newly generated damage instead. The active simulation does not add those historical unrepaired records as a baseline in calm weather.

**Read the two map views separately:** forecast hexagons show expected hours across possible outcomes; purple circles and damage markers show one sampled outcome. A location may have positive forecast risk and no outage in that sample.

Circles summarize geographic spread, not outage probability or damage density. Each outage is drawn as one circle per ~1 km grid cell that has affected customers (`OUTAGE_CELL_DEGREES` in `map.js`), so a long outage appears as a trail of small circles. Centers are coarsened, the minimum radius is 300 m, and each radius covers that cell's farthest affected customer plus 100 m. Unaffected locations may lie inside a circle. Use the selected location's network-based tool result, not apparent circle inclusion, to determine its simulated status.

**Repair times come from the team's time sheet** (`Chat AEP Time Calculations.csv`, stored as `jobs` in `public/data/labor.json` with each job's sheet number). Every job is the sum of component times from AEP's `Install_Labor_HackOHIO.xlsx` workbook, and the program picks the job for each damaged asset in `repairJob()` (`src/restorationModel.js`):

| Damaged asset | Sheet job |
|---|---|
| Pole carrying only service wire | 1, Secondary Pole (4.47 h) |
| Pole on the primary line | 2, Primary Pole (5.66 h) |
| Pole with a transformer, by kVA | 3a-3l, Transformer Pole (8.2-8.6 h) |
| Pole with a fuse bank, switch, or recloser | 4, 6, 7 (6.2-8.1 h) |
| Wire (primary or secondary) | 9, Damaged Wire (0.45 h) |
| Transformer, by kVA | 8a-8l, Standalone Transformer (2.0-2.4 h) |
| Fuse bank, recloser, capacitor bank, switch | 10a, 10c, 10b, 11b |

Equipment on a pole is found by the `location_n` it shares with the pole. Hours above are direct labor; the sheet's rules then apply: ×4.5 indirect labor multiplier, +0.5 h restricted-access adder when `Access_Iss = Yes` (or **Roads blocked** is ticked), a 50% chance of one cubic foot of hand digging (+1.5 h) on jobs that set a pole (a fixed draw per pole site, hashed from the pole ID), and 0.5 h of lunch for every 8 hours of continuous crew work (`withLunchBreaks()`). Step transformers and lights aren't on the sheet and use workbook components (`recipes`). The default of 110 crews is calibrated so the worst storm matches its recorded repair times (median 1 day, 90th percentile 3 days from report to repair).

Repair work is calculated from these jobs and the indirect multiplier. For each sampled outage, `restorationOrder()` waits for upstream dependencies, then puts ready repairs that restore a priority location first, then prioritizes by customers served per repair hour. One crew handles the area's ordered steps. `stepOfCustomer` identifies the step that restores each affected customer; the map and assistant refresh this lookup together whenever the storm level changes.

Step times describe elapsed work after the area's crew starts, with normal access. The assistant's planning range additionally considers declared access allowances and waiting for work elsewhere in the storm. It excludes the area's own labor from that outside backlog to avoid double counting. Crew count can change the modeled wait while the area's baseline one-crew sequence stays the same. `restorationRange()` and `sampledRestorationRange()` in `restorationModel.js` contain the duration formulas.

Hypothetical forecasts use expected work and the selected location's assumed repair-queue position. If no outage was generated at the selected location, the active-sample tool supplies no restoration duration. A request for another storm level returns a hypothetical forecast without moving the map. These are simplified scheduling assumptions, not a full dispatch optimizer or calibrated confidence intervals.

Use the same scenario helper when adding a module under `src/`:

```js
// Import the committed-grid loader and reusable scenario functions.
import { loadGrid, prepareForecast } from "./outages.js";
import { buildStormScenario } from "./stormScenario.js";
import { stormLevel, levelSeverity } from "./stormLevels.js";

// Load and unpack the browser dataset.
const grid = await loadGrid();

// Prepare exposure once for subsequent storm-level changes.
const prepared = prepareForecast(grid);

// Generate a winter storm using the map's default seed.
const severity = levelSeverity(stormLevel("winter_storm"), grid.meta.worstStorm);
const scenario = buildStormScenario(grid, prepared, severity, 2026);

// Read safe aggregate results for this sampled outcome.
console.log(scenario.summary);
```

Browser code uses `fetch()`; Node build scripts use local file readers. The normalized catalog under `data/extracted/normalized/` is not automatically served or displayed. Some network associations use spatial fallbacks, and historical weights and storm-window calibration are prototype assumptions rather than a validated weather-to-damage model.

## Outage Assistant

Searching a covered location opens the chat view over the loaded map; uncovered searches stay on the map with a coverage notice. The browser posts conversation turns to `/api/chat`; `server/chat.js` adds the server-owned prompt and tool definitions and calls Anthropic. Tool requests execute in `src/assistantTools.js` against the active map state, and the browser returns their results for the next assistant turn.

- `search_address` selects a nearby service node. `get_current_status` describes its sampled outage status, not its real electricity supply.
- `set_storm_level` moves the slider to a named level (Claude matches the customer's words, such as "a thunderstorm" or "a hurricane") and updates the map and returns forecast expectations plus a separate sampled-outcome summary.
- `get_outage_risk` reports forecast risk. `estimate_restoration` reports an assumption-based range when available. Crews and access default to the storm panel's settings; Claude passes values only for a what-if.
- `check_alert_eligibility` applies documented challenge rules and declared needs.
- `draft_notifications` writes the four customer messages from the same numbers: the displayed sample's restoration range when this location has an outage, otherwise the storm forecast's range, and no times for calm weather or an unreliable match. The "estimate updated" example reruns the estimate with half the crews. Each message is labeled simulated and checked to fit in 320 characters. The **Preview my alerts** button calls it directly (no AI round trip), and the chat shows the same card when Claude calls it. Nothing is enrolled or sent.

The prompt requires fresh tool reads for follow-up predictions, separation of sampled outcomes and expectations, and a fallback for unreliable matches. Customer-facing explanations appear under "How I got this". Tool results exclude premise IDs, coordinates, device IDs, circuit IDs, and life-support flags. Needs are declared by the customer rather than inferred from private records.

**Confidence.** Uncovered addresses return low confidence without using a nearby node's status or predictions. For covered addresses, `confidenceFor()` in `assistantTools.js` returns low when there's no usable network match (no upstream data, or the address is over 500 m from a service point). Otherwise it's high only when all three hold: the address is within 150 m of a service point, the customer's lines have recorded storm damage (their failure weight is above the no-history baseline), and the storm level matches a real storm in the records (`observed` in `stormLevels.js`). Missing any of these gives medium, and the reason names what's missing.

**Priority locations.** `scripts/dataBuildScripts/add-priority-locations.js` matches each hospital, fire station, and ambulance station to the nearest customer point with network data (within 300 m; 40 of 52 match, the rest are outside the service area) and stores a per-device count in `grid.devices.priority`. No facility names or coordinates reach the browser. Repairs on those devices go first in each outage's steps and near the front of the storm queue. The assistant says when a customer's repair also restores a priority location but never what or where it is, and the outage panel doesn't mark which step it is.

**Safety and handoff.** `chatbot.js` checks every typed message against `SAFETY_RULES` and shows a red safety banner before the assistant replies, so the warning doesn't depend on the AI. Downed lines, sparks, fire, and medical emergencies are also flagged for a person. **Talk to a person** shows the summary an agent would receive (`handoffSummary()`: the customer's matched address, storm level, simulated status, restoration step and range, confidence, declared needs, and flagged reasons). It's simulated: no one is contacted.

## Demonstration and review

Use the committed grid and seed 2026 for these reference counts:

| Storm level | Sampled damage locations | Customers without power | Outage areas |
|---|---:|---:|---:|
| Calm | 0 | 0 | 0 |
| Thunderstorm | 9 | 3,295 | 7 |
| Winter storm | 33 | 7,690 | 21 |
| Major storm (Helene's remnants) | 169 | 19,589 | 66 |
| Worst on record | 891 | 46,845 | 148 |

Counts can change with the dataset or seed. Expected forecast counts need not equal sampled counts. To demonstrate an adjustable scenario:

1. Start at Calm, then show Thunderstorm, Major storm, and Worst on record. Return to Major storm to show repeatability.
2. Select a team-approved location with usable network data. Change the storm level and confirm that map counts, selected-location status, and fresh assistant tool responses agree.
3. Tell the assistant "a hurricane is coming" and check that it picks Major storm. Return to the map to show that the same scenario changed.
4. Compare the selected location's restoration step in the search result and assistant response. Move the **Repair crews** slider or tick **Roads blocked**: step times, the heatmap, and the assistant's range change while the sampled damage stays the same. Step times start when the area's crew begins; the range may also include waiting elsewhere.
5. Ask for alert eligibility and a draft pre-storm notification. Explain the rules and show the draft without claiming it was sent.
6. Ask whether the app can confirm real power status. It should explain the simulation limitation. An unreliable location match should trigger the documented fallback.
7. Type "there's a downed line in my yard". The red safety banner appears before the assistant answers; then click **Talk to a person** to show the agent summary.

The storm-level comparison demonstrates an adjustable scenario input. Review the challenge's other customer-journey requirements separately before claiming the whole submission is complete.

## Optional: change or rebuild the datasets

> **Data layout change (privacy for the demo).** `public/data/customers.json` used to hold every customer field (premise, transformer, circuit, street, life support). It now holds only rounded `lng`/`lat`, because everything in `public/` can be downloaded from the running app. The full file moved to `data/extracted/customers.json` (ignored by Git), and every data script now reads it from there. `npm run data:grid` writes the slim public copy.
>
> If a data script fails with `ENOENT ... data/extracted/customers.json`, or complains that a field such as `premise` or `transformer` is missing, restore the full file from Git history (the last commit that had it), then rerun the script:
>
> ```sh
> # Restore the private file without printing its contents or changing encoding.
> node --input-type=module -e "import {execFileSync} from 'node:child_process'; import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('data/extracted',{recursive:true}); writeFileSync('data/extracted/customers.json',execFileSync('git',['show','a3a4575:public/data/customers.json'],{maxBuffer:32*1024*1024}));"
> ```
>
> The Node command preserves the original bytes on Windows and other platforms; shell redirection in older PowerShell can otherwise write an unsuitable encoding.
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

This command can use substantial memory; the package script allows Node up to 8 GiB of heap. It overwrites both `public/data/grid.json` and `public/data/customers.json`. Review and commit the aligned pair together.

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
| `node` or `npm` is not recognized | Install Node.js with npm, reopen the terminal, and check PATH. |
| PowerShell blocks `npm.ps1` | Use `npm.cmd ci` or `npm.cmd run dev`. |
| Missing Google Maps key or map authorization errors | Check root `.env`, enabled APIs, allowed origin, and restart/rebuild as appropriate. |
| No outage circles or damage markers | In calm weather there is no generated damage; choose a stronger storm level and turn on the matching layer button beside the address search bar. |
| Missing `@anthropic-ai/sdk` during build | Run `npm.cmd ci` after pulling dependency changes, then retry the build. |
| Chat says it is not configured | Set the server-only `ANTHROPIC_API_KEY`, restart Vite, and begin a fresh conversation. |
| Chat route missing on static hosting | Provide the server middleware or use local Vite dev/preview; `dist/` alone has no API route. |
| Missing public customer/grid JSON | Restore the tracked pair from the intended build; a rebuild needs the optional pipeline inputs. |
| Data script reports missing private customers or missing premise fields | Restore `data/extracted/customers.json` as described in the optional pipeline section; never point data scripts at the slim public copy. |
| Windows file-lock errors during dependency installation | Stop this project's dev/preview server with Ctrl+C before retrying. |
