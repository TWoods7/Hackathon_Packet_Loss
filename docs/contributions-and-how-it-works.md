# Who built what, and how it works

A study guide for judging. Each person has a section covering what they own, how it works step by step, the numbers worth memorizing, and the questions a judge is likely to ask, with answers. Read the **Everyone** section first; any of us might get those questions.

| Person | Owns |
|---|---|
| [Andrew Schlecht](#andrew-schlecht-repair-job-times) | Repair job times: the time sheet, labor rules, and how they become restoration hours |
| [Jonah Femiani](#jonah-femiani-chatbot-hexagons-overlays) | The Outage Assistant chatbot, forecast hexagons, map point overlays, and the customer-facing features around them |
| [Taylor Woods](#taylor-woods-data-pipeline-and-storm-simulation) | The data pipeline (the "database"), the storm simulation, and the chatbot tools that read it |
| [Alex Wang](#alex-wang-outage-circles-ui-and-network-graph-rules) | Outage circles, connecting data to circles, UI design, and the network graph rules |

---

## Everyone

### The 30-second pitch

Chat AEP is an outage concierge for a storm. A customer searches their address. The map shows a storm forecast, and an assistant answers the brief's four questions: will I lose power, how long will it take, what should I do, and do I qualify for alerts. Every number comes from a model built on AEP's real (anonymized) network, damage history, and labor data, never from the AI guessing. Everything is labeled as simulation.

### How the pieces connect

```
AEP shapefiles + upstream TXT + labor workbook + team time sheet
        │  (Taylor: scripts/dataBuildScripts/*, run with npm run data:grid)
        ▼
public/data/grid.json          devices, customer→device chains, failure candidates, priority flags
public/data/customers.json     rounded customer locations only (privacy)
public/data/labor.json         repair jobs and labor rules (Andrew)
        │
        ▼  browser
src/stormLevels.js     slider level → expected broken poles and wires
src/outages.js         forecast (chance of outage, expected hours), outage groups, restoration steps
src/stormSimulation.js one seeded random storm outcome (Taylor)
src/restorationModel.js every time formula (Andrew's jobs, lunch, crews, ranges)
src/map.js             hexagons, circles, markers, panels, sliders (Jonah, Alex)
src/assistantTools.js  the chatbot's tools, run against the live map state
        │
        ▼
server/chat.js + server/prompt.js   relays each turn to Claude with the system prompt and tool list (Jonah)
```

### How the brief's minimum demo maps to the app

| Brief requirement | Where it is |
|---|---|
| 1. Customer selects a location | Address search box (map.js `searchAddress`) |
| 2. Outage risk with confidence and explanation | `get_outage_risk` tool: risk band, confidence with a reason, factors; "How I got this" in chat |
| 3. Explore scenarios, get a restoration range | Storm strength slider, crew slider, roads-blocked box; `estimate_restoration` returns low/typical/high |
| 4. Preparation actions and alert eligibility | "What you can do" section of answers; `check_alert_eligibility` |
| 5. At least one proactive message | **Preview my alerts** button: four messages (pre-storm, outage confirmed, estimate updated, restored) |
| 6. Privacy, safety, uncertainty, limitations | Privacy-safe data files, safety banner, confidence levels, fallback for bad matches, "simulated" labels |

### Privacy (anyone can be asked this)

- Everything in `public/` can be downloaded from the running app, so it holds only what the browser needs. The public customer file is just `lng`/`lat`, rounded to 4 decimals (about 11 m). Premise IDs, transformer IDs, street names, and life-support flags stay in `data/extracted/customers.json`, which Git ignores.
- `grid.json` has no device coordinates. A transformer that serves one home would otherwise reveal that home's exact location.
- The map never draws individual homes. Hexagons need at least 10 customers; outage circles snap to a 150 m grid and are at least 300 m across their radius.
- Tool results never contain premise IDs, coordinates, device IDs, or circuit IDs. Priority facilities (hospitals, stations) are a count on a device, never a name or a location.
- The server logs tool names and token counts, never message text. Addresses go to Google (geocoding) and Anthropic (chat) only.

### Honest limitations (say these before a judge finds them)

- It's a simulation from historical damage, not a live outage feed, and estimates aren't official restoration times.
- Storm strength means expected broken poles and wires, not wind speed or rainfall. The model has no weather input.
- The risk model is fit to one area's 2022-2026 records; there's no holdout validation.
- Address search matches the nearest customer point, which may not be the customer's actual account.
- Ranges are planning estimates from stated assumptions, not statistical confidence intervals.

---

## Andrew Schlecht: repair job times

**You own:** `Chat AEP Time Calculations.csv` (the time sheet), stored as `jobs` in `public/data/labor.json`; how a damaged asset becomes a job; the labor rules (indirect multiplier, adders, excavation, lunch); and the crew calibration that depends on them.

### How it works

1. **Component times come from AEP's workbook** (`Install_Labor_HackOHIO.xlsx`). Each component has install and removal hours of direct labor, for example base pole 3.43 h (the workbook's medium pole), crossarm 0.586 h, fuse cutout 0.384 h, recloser 1.098 h.
2. **A job is a sum of components.** The sheet defines what a crew actually replaces for each kind of repair. A Primary Pole (job 2) is base pole + crossarm + bracket + grounding + insulator = 5.66 h. A Transformer Pole (3a-3l) adds a fuse cutout, connector, and the transformer for its kVA. The average connector uses 0.26 h (install 0.215 + removal 0.045).
3. **The program picks a job for each damaged asset** (`repairJob()` in `src/restorationModel.js`). Damage reports carry an asset type but no damage type, so the job follows the asset:

   | Damaged asset | Job |
   |---|---|
   | Pole carrying only service wire | 1, Secondary Pole, 4.47 h |
   | Pole on the primary line | 2, Primary Pole, 5.66 h |
   | Pole with a transformer (by kVA) | 3a-3l, 8.2-8.6 h |
   | Pole with a fuse bank / switch / recloser | 4 (6.22 h) / 6 (7.73 h) / 7 (8.15 h) |
   | Wire, primary or secondary | 9, Damaged Wire, 0.45 h |
   | Transformer (by kVA) | 8a-8l, 2.0-2.4 h |
   | Fuse bank / capacitor bank / recloser / switch | 10a / 10b / 10c / 11b |

   What's mounted on a pole is found by the `location_n` code the pole shares with its equipment. If a pole carries several devices, the job follows recloser → transformer → switch → fuse, because a recloser pole job already includes a transformer and a transformer pole job already includes a fuse cutout.
4. **Rules from the sheet, applied in order:**
   - **Access adder:** +0.5 h direct labor when the report says `Access_Iss = Yes`, or when **Roads blocked** is ticked.
   - **Excavation:** jobs that set a new pole have a 50% chance of one cubic foot of hand digging (+1.5 h). The draw is fixed per pole site (a hash of the pole ID), so a site either needs digging or doesn't, in every storm.
   - **Indirect labor multiplier, ×4.5:** turns wrench time into person-hours, covering staging, safety briefings, traffic control, material handling, switching, travel, and delays.
   - **Crew of 4:** clock hours = person-hours ÷ 4.
   - **Lunch:** +0.5 h for every 8 hours of continuous crew work (`withLunchBreaks()`), applied to each crew's running total, never twice.
5. **Where the hours go:** every failure candidate (pole) in `grid.json` stores its job's direct hours. The storm simulation copies those into each simulated repair, and the restoration model turns them into step times and ranges.

### Numbers to know

- Indirect labor multiplier **4.5**; crew size **4**; lunch **0.5 h per 8 h**; access adder **0.5 h**; hand dig **1.5 h per cubic foot**, 50% chance.
- Average pole job: **6.75** direct hours (before the sheet it was 4.0, because service poles were treated as wire fixes).
- Default **110 crews**: calibrated so the worst recorded storm (Feb 12-17, 2025) averages about 2 days without power and finishes every repair in about 2.9 days. The records show a median of 1 day, 75th percentile 2 days, 90th percentile 3 days from report to repair.

### Likely questions

- **"Where do your repair times come from?"** AEP's own labor workbook gives hours per component. Our sheet groups components into the jobs a crew actually does, and each job is a sum of workbook values you can trace line by line in `labor.json` by job number.
- **"Why 4.5×?"** It's the workbook's indirect labor multiplier: wrench time is only part of a job; the rest is travel, setup, safety, and coordination.
- **"Why 1 cubic foot of digging?"** The workbook prices hand digging per cubic foot and doesn't give a volume, so 1 cubic foot is our stated assumption, applied to half of pole sites. *(Be ready to justify or revise this; it's the one number we chose.)*
- **"Do you count phases?"** No. The sheet counts one unit per job, and we follow it.
- **"How did you pick 110 crews?"** It's the one free setting. We tuned it so the model reproduces the recorded repair times of the biggest storm in the data. If the job hours change, it has to be re-tuned (the comment next to `CREWS` says so).
- **"What isn't covered?"** Step transformers and lights aren't on the sheet (1 and 5 reports), so they use workbook components. Capacitor bank poles (job 5) can't be identified because there's no capacitor map layer.

---

## Jonah Femiani: chatbot, hexagons, overlays

**You own:** the Outage Assistant (server relay, system prompt, tools, chat UI), the forecast hexagons, the point overlays (damage markers, address and nearest-point markers), and the features built around them: privacy layout, storm levels, restoration steps, confidence, priority locations, alert preview, safety banner, crew/roads controls.

### The chatbot, end to end

1. **Searching an address** geocodes it (Google), finds the nearest customer point, and fires a `location-searched` event. The chat opens over the map (the map stays loaded underneath so tools keep working).
2. **The browser posts the conversation** to `/api/chat` (`server/chat.js`). The server adds the system prompt and tool definitions (`server/prompt.js`), so the browser can't change them, and calls Claude (`claude-sonnet-5-5`). It accepts only user and assistant turns, caches the fixed prompt, and logs only tool names and token counts.
3. **When Claude calls a tool, the browser runs it** (`src/assistantTools.js`) against the live map state and sends the result back. That's why the chat and the map always agree. Up to 8 tool rounds per message.
4. **Tools:** `search_address`, `get_current_status`, `set_storm_level`, `get_outage_risk`, `estimate_restoration`, `check_alert_eligibility`, `draft_notifications`. Schemas are strict (exact inputs only). Results are filtered for privacy before they leave the browser.
5. **The answer format** comes from the prompt: **What we know / Our estimate / What you can do**, ranges never single times, plain language, a "⚠️ Safety:" line when relevant, and an `<explanation>` that the chat shows collapsed as "How I got this".
6. **Rule 1 of the prompt:** every number must come from a tool. The AI explains; the model calculates.

### Features in the chat

- **Confidence** (`confidenceFor()`): *low* if there's no network data or the address is over 500 m from a service point; *high* only with all three of: address within 150 m, recorded storm damage on the customer's lines, and a storm level that matches a real recorded storm. Otherwise *medium*, with the reason spelled out. At Major storm, about 85% of homes get high.
- **Preview my alerts:** four messages built in code (not by the AI) from the model's numbers, each under 320 characters and labeled simulated. The "estimate updated" example reruns the estimate with half the crews. A checkbox lets the customer declare powered medical equipment, which adds a phone call and priority escalation. Needs are only ever declared, never inferred.
- **Safety banner:** every typed message is checked against `SAFETY_RULES` (downed lines, sparks, trees on wires, fire or smoke, generators/carbon monoxide, flooding, medical emergencies). A red banner appears *before* the AI answers, so safety doesn't depend on the AI. Tested so "fire station" or "smoke detector" don't trigger it.
- **Talk to a person:** shows the summary a utility agent would receive (address, storm level, simulated status, restoration step and range, confidence, declared needs, flagged reasons). Simulated; no one is contacted.
- **Fallback:** a low-confidence match gets no time estimate, general advice, and a pointer to the official outage map.

### Hexagons (the storm heatmap)

1. `buildHexGrid()` (`src/hexGrid.js`) groups customers into pointy-top hexagons **300 m** from center to corner, using a flat projection around the area's middle latitude.
2. Hexagons with fewer than **10** customers are dropped, so a value can't describe one household. That leaves **1,730 hexagons** covering 110,399 of 117,642 customers.
3. For each customer the forecast computes **expected hours without power = chance of losing power × hours it would last**. Each hexagon shows the **average** over its customers (`averageIntoHexes()`), so dense neighborhoods don't look riskier just for having more homes.
4. Colors run yellow → dark red over a fixed **0.25 to 48 hour** range, so a color means the same thing at every storm level. Below 0.25 h a hexagon is transparent.

### Point overlays

- **Damage markers:** red rings at each simulated damage location (toggle: Damaged equipment). Clicking shows the damage type and asset.
- **Address marker and nearest point:** after a search, the searched address and the matched customer point, joined by a line (toggle: Nearest to you).
- Individual customers are never drawn.

### Restoration steps and priority (built with Andrew's hours)

- In an outage, power can't return past a damaged device until every damaged device between it and the substation is fixed. `restorationOrder()` orders repairs: a repair is *ready* once everything upstream is done; among ready repairs, one that restores a **priority location** goes first, then the one serving the **most customers per hour of work**. One crew works them in turn.
- Each step has a time and a count of customers it brings back. The outage panel lists them; the search result and assistant say which step restores this home.
- **Priority locations:** 52 public facilities (5 hospitals, 37 fire stations, 10 ambulance stations); 40 match a customer point within 300 m. Their lines' devices get a priority count; nothing else about them reaches the browser.

### Numbers to know

- Model `claude-sonnet-5-5`; 7 tools; max 8 tool rounds; messages ≤ 320 characters.
- Hexagons: 300 m, minimum 10 customers, 1,730 shown, color range 0.25-48 h.
- Confidence thresholds: 150 m (close), 500 m (unreliable).

### Likely questions

- **"How do you stop the AI from making up numbers?"** It can't produce them: the prompt requires a tool for every number, the tools compute everything from the model, and strict schemas fix the inputs. The server owns the prompt, so a user can't rewrite it.
- **"What if the AI is wrong about safety?"** Safety doesn't rely on it: the banner is plain code that runs before the AI replies.
- **"Why hexagons instead of points?"** Privacy (no single home) and readability (an area average). The 10-customer minimum is the privacy guarantee.
- **"What does 'high confidence' mean?"** Three specific conditions, all checkable; anything missing is named in the reason. It isn't a statistical probability.
- **"Why are the alert messages written by code, not the AI?"** So they're instant, consistent, always under SMS length, and always use the model's real numbers. The AI explains them.
- **"Do you infer medical needs?"** Never. Only from the customer's own checkbox or words.

---

## Taylor Woods: data pipeline and storm simulation

**You own:** the scripts that turn AEP's raw files into the app's data (`scripts/dataBuildScripts/`), the storm damage simulation (`src/stormSimulation.js`, `src/stormScenario.js`), and the chatbot tools' connection to the simulated storm.

### The data pipeline (the "database")

There's no database server: the pipeline produces JSON files, and the browser loads them. Steps, in order:

1. **Export GIS layers** (`export-remaining-layers.js`, QGIS/GDAL): shapefiles → GeoJSON in EPSG:4326 for poles, primary and secondary lines, switches, fuses, reclosers, transformers, damage reports, and fire/ambulance stations.
2. **Parse the upstream file** (`build-upstream.js`): `matched_upstream.txt` has one line per premise, then the equipment between that premise and the substation, each entry `sourceTable*deviceId*deviceType*location`. It becomes an ordered chain per premise (transformer first, substation breaker last). Duplicate premises or malformed entries stop the build instead of being silently skipped.
3. **Validate** (`validate-upstream-links.js`, `validate-transformer-links.js`): checks each customer's declared transformer against its chain and writes exception reports. Results: **117,595 of 117,642** customers have a chain (47 don't), and **117,556** agree on their transformer (39 disagree).
4. **Join and crosswalk** (`build-customer-network.js`, `build-recloser-crosswalk.js`, `build-fuse-links.js`): link upstream devices to GIS records. Reclosers are matched by location and type as *candidates*, not verified identities.
5. **Normalize** (`build-assets-catalog.js`): one consistent schema for all equipment, kept internal.
6. **Build the grid** (`build-outage-grid.js`): devices, customer chains, protection zones, failure candidates with weights and repair hours, plus the public customer file. Then `add-priority-locations.js` adds priority flags. `npm run data:grid` runs both (about 4 seconds).

**Privacy split:** the full customer file lives in `data/extracted/` (ignored by Git). The build writes only rounded locations to `public/`. If a teammate's script can't find `data/extracted/customers.json`, the README and `AGENTS.md` explain how to restore it from Git history.

### Failure weights (what makes a line risky)

- Each pole on the network is a **failure candidate** (77,224 of them; 29,789 poles aren't linked to the network and are left out).
- Its **weight** = its circuit's historical pole-and-primary-wire damage per pole + a small floor (0.0005; half for service-only poles). A circuit with no recorded damage gets only the floor, which is how confidence knows a line "has no storm history".
- A customer's **exposure** = the sum of weights of every pole that can cut their power (every pole behind any device on their chain).

### The storm simulation

1. **Storm level → target damage.** The slider level gives an expected number of broken poles and wires (e.g. Winter storm 33, Major storm 157, worst on record 882).
2. **Find the storm scale** (`stormForecast()`): binary search for the scale where the expected number of failures, Σ (1 − e^(−scale × weight)), equals the target.
3. **Forecast:** each customer's chance of losing power is 1 − e^(−scale × exposure) ("at least one pole on my line fails"). Expected hours = chance × hours it would last. This drives the hexagons and risk bands.
4. **Sample one outcome** (`simulateStormDamage()`): every candidate gets one seeded random draw (seed **2026**); it fails if the draw is below its failure chance. Every candidate draws every time, so the same storm always gives the same damage, and a stronger storm keeps the earlier failures and adds more.
5. **Build the scenario** (`buildStormScenario()`): failed poles trip their devices; customers group under their most upstream tripped device (one outage per group); repair work is totaled. Crews and blocked roads change repair times, never which poles fail.

### The two views, and why they differ

- **Hexagons = expected values** across all possible storms of that strength.
- **Circles and damage markers = one sampled storm.** A home can have real risk and still have no outage in the sample. The tools report this as `outage_simulated: false` rather than inventing a time.

### Chatbot tools that touch the simulation

- `set_storm_level` moves the slider and returns both the forecast (expected) and `sampled_outcome` (this storm's actual counts), clearly separated.
- `get_current_status` reports the home's status *in the displayed simulation*, never its real power.
- `estimate_restoration` at the displayed level uses the sample's actual repairs and steps; at another level it gives a labeled hypothetical forecast without moving the map.

### Numbers to know

- 117,642 customers; 32,600 devices; 11,570 protection zones; 77,224 failure candidates.
- 1,659 damage reports from 2022-2026, grouped into 9 storms (days with 10+ reports, gaps up to 2 days).
- Worst storm: Feb 12-17, 2025, 882 broken poles and wires. Helene's remnants (Sept 27 - Oct 2, 2024): 157.
- Seed 2026. Reference counts: Thunderstorm 3,295 customers out; Winter storm 7,690; Major storm 19,589; worst 46,845.

### Likely questions

- **"Is this a real database?"** It's a reproducible build pipeline: raw AEP files in, validated JSON out, with exception reports for every join that didn't line up. For a prototype that has to run anywhere, that beats a server.
- **"How do you know the network links are right?"** We validate every customer's declared transformer against its chain: 117,556 agree, 39 don't, 47 have no chain, all in reports. Recloser matches are labeled candidates.
- **"Why does the same storm level always look the same?"** The simulation is seeded on purpose, so judges see repeatable results. A different seed gives a different but equally likely storm.
- **"Why is my home at risk but not out?"** The heatmap is the average over all possible storms; the circles are one possible storm.
- **"Where does risk come from?"** Each circuit's own history of broken poles and wires, per pole, plus how many poles sit on the customer's line.

---

## Alex Wang: outage circles, UI, and network graph rules

**You own:** turning groups of affected customers into circles, connecting outage data to each circle (click, hover, panel), much of the UI design, and the rules for building the network graph (nodes, edges, and protection zones).

### Outage circles

1. **Each outage is a group of customers** sharing the same most-upstream tripped device (from the scenario).
2. **The group is split into ~1 km cells** (`outageCircles()` in `src/map.js`, cell size `OUTAGE_CELL_DEGREES` = 0.01°), so a long outage shows as a trail of small circles instead of one circle over empty land.
3. **One circle per cell** (`outageCircle()`): center = middle of the cell's customers' bounding box, **snapped to a ~150 m grid** (0.0015°); radius = farthest customer in the cell + 100 m, **never less than 300 m**. The snap and the minimum are the privacy guarantee: a circle can't point at one home.
4. **History:** we first drew convex hulls around each group (`scripts/boundingAlgorithm.js`, a monotone-chain hull). Circles replaced them because a hull around a few points can trace individual homes, and circles stay coarse. The hull code is still in the repo but no longer used.
5. Splitting into cells took the largest circle from about 3.7 km radius to about 840 m (49 outages → 144 circles in the reference snapshot).

### Connecting data to circles

- **All circles of one outage share one map layer**, so hovering highlights the whole outage and clicking any of its circles opens the same panel (`zoneByLayerId` maps layer → outage).
- **The panel** (`outageDetails()`): customers without power, cause, repair work in person-hours, and the restoration steps ("N customers back in about X hours"). Step counts under 10 show as "fewer than 10".
- **Tooltip** on hover: device type and customers without power. Escape or the close button dismisses the panel.
- Circles are approximate: they can include unaffected homes. The assistant is told to use the tools, never "is my house inside a circle", to decide a home's status.

### UI design

- Map-first page: search panel top left, legend with layer toggles, storm panel bottom right, map controls top right.
- **Storm panel:** the changing text sits above the controls. The panel is pinned to the bottom and grows upward, so the sliders never move while you drag.
- **Storm strength slider:** named levels from real storms (Calm, Thunderstorm, Winter storm, Helene's remnants, Feb 2025) instead of percentages. A 5% storm used to mean "a winter storm", which confused people.
- **Chat:** full-page view over the map, large Back to map button, browser Back works, collapsed "How I got this", buttons for alerts and a person.
- Accessibility: keyboard focus management in panels, live regions for updating text, screen readers announce the storm level name.

### Network graph rules (in `build-outage-grid.js`)

1. **Nodes** are `circuit|location`: a location code on a specific circuit. Two circuits sharing a location never merge.
2. **Edges** are primary line segments: each segment connects its two end locations on its circuit.
3. **Stop locations** are where protection happens: locations of protective devices (fuses, reclosers, sectionalizers; breakers are handled separately) and normally-open switches or fuses.
4. **Protection zones:** flood-fill the graph from every node without crossing a stop location. Each connected piece is one zone: everything a single protective device isolates. Result: 11,570 zones.
5. **Which device protects a zone:** among the transformers in the zone, take each one's first protective device upstream (from the customer chains), and choose the most upstream one (the one feeding the most customers).
6. **Damage at a stop location** (on the boundary between zones) trips the most upstream adjacent device.
7. **Why it matters:** this is how a broken pole becomes "these customers lose power". A pole is mapped to the zone at its location, the zone to its protecting device, and every customer whose chain passes through that device goes dark. Service-only poles that aren't on the graph fall back to the nearest transformer.

### Numbers to know

- Circles: ~1 km cells, 150 m snap, 300 m minimum radius, +100 m margin.
- Graph: 11,570 protection zones; median chain length 4 devices, longest 13.

### Likely questions

- **"Why circles and not exact outage shapes?"** Privacy and honesty: exact shapes would trace individual homes, and the outage area is an estimate anyway. Circles say "roughly here" and nothing more.
- **"Why split one outage into several circles?"** One circle had to stretch over every customer in a long outage, up to 3.7 km, covering empty land. Per-cell circles follow the streets that are actually affected.
- **"How do you decide who loses power when a pole breaks?"** Graph rules: the pole's location belongs to a protection zone; the zone's protecting device trips; everyone downstream of that device loses power.
- **"Why stop zones at open switches?"** A normally-open switch is a deliberate break between circuits; power doesn't flow across it, so a fault on one side can't affect the other.
- **"Why did you replace the percentage slider?"** "5%" sounded like light rain but meant a winter storm's damage. Named levels tied to real storms tell people what the storm actually is.
