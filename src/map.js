import { GoogleMapsOverlay } from "@deck.gl/google-maps";
import { LineLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { buildHexGrid, averageIntoHexes } from "./hexGrid.js";
import {
  loadGrid,
  prepareForecast,
} from "./outages.js";
import { CREWS, CREW_SIZE, repairClockHours, withLunchBreaks } from "./restorationModel.js";
import { registerMapApi } from "./assistantTools.js";
import { STORM_LEVELS, levelSeverity, levelLineDamage } from "./stormLevels.js";
// Use the tested sampler and outage calculations as one source of scenario state.
import { buildStormScenario } from "./stormScenario.js";

const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// Fallback center: AEP challenge service area, southwest Virginia
const DEFAULT_CENTER = { lat: 37.237, lng: -79.949 };

// deck.gl needs numeric RGB(A) arrays; color values live in style.css.
const mapStyles = getComputedStyle(document.documentElement);
// Read a CSS color as the numeric array deck.gl needs.
function layerColor(property) {
  return mapStyles.getPropertyValue(property).trim().split(",").map(Number);
}
const NEAREST_COLOR = layerColor("--map-nearest");
const ADDRESS_COLOR = layerColor("--map-address");
const OUTLINE_COLOR = layerColor("--map-outline");
const TRANSPARENT_COLOR = layerColor("--map-transparent");
const HULL_FILL_COLOR = layerColor("--map-hull-fill");
const HULL_SELECTED_FILL_COLOR = layerColor("--map-hull-selected-fill");
const HULL_LINE_WIDTH = Number(mapStyles.getPropertyValue("--map-hull-line-width"));
const HULL_HOVER_LINE_WIDTH = Number(mapStyles.getPropertyValue("--map-hull-hover-line-width"));
const DAMAGE_COLOR = layerColor("--map-damage");
// Storm heatmap: yellow (few expected hours without power) to dark red (many).
const HEAT_COLORS = [1, 2, 3, 4, 5, 6].map((step) => layerColor(`--map-heat-${step}`));
// Fixed hour range so colors mean the same thing at every slider position.
const HEAT_DOMAIN = [0.25, 48];

// Color for a value in HEAT_DOMAIN, blending between neighboring HEAT_COLORS.
// Below the range the hexagon is see-through.
function heatColor(hours) {
  if (hours < HEAT_DOMAIN[0]) return TRANSPARENT_COLOR;
  const t = Math.min(1, (hours - HEAT_DOMAIN[0]) / (HEAT_DOMAIN[1] - HEAT_DOMAIN[0]));
  const position = t * (HEAT_COLORS.length - 1);
  const low = Math.floor(position);
  const high = Math.min(low + 1, HEAT_COLORS.length - 1);
  const mix = position - low;
  return HEAT_COLORS[low].map((channel, i) => Math.round(channel + (HEAT_COLORS[high][i] - channel) * mix));
}

// Outage circles never point at a single home: centers snap to a ~150 m grid
// and every circle is at least 300 m across its radius.
const OUTAGE_GRID_DEGREES = 0.0015;
const OUTAGE_MIN_RADIUS_M = 300;
// Large outages split into one circle per ~1 km cell, so a long outage shows as
// a trail of small circles instead of one circle covering empty land.
const OUTAGE_CELL_DEGREES = 0.9;

// Shown wherever outage results appear: the data has no live outage feed.
const SIMULATION_NOTE = "One possible storm outcome from historical damage patterns; not live outage information.";

const EARTH_RADIUS_M = 6371000;

// Load Google Maps and wait until it is ready to use.
function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    window.__initMap = resolve;
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__initMap`;
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load Google Maps script"));
    document.head.appendChild(script);
  });
}

// Fetch customer data and turn each compact row into a customer object.
async function loadCustomers() {
  const res = await fetch("/data/customers.json");
  if (!res.ok) {
    throw new Error("Missing public/data/customers.json. Run `npm run data:customers` first.");
  }
  const { fields, rows } = await res.json();
  // index matches the customer's position in grid.json's customerChains.
  return rows.map((row, index) => ({ ...Object.fromEntries(fields.map((f, i) => [f, row[i]])), index }));
}

// Calculate the distance in meters between two latitude/longitude locations.
function distanceMeters(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Find the closest customer and return that customer and the distance in meters.
function findNearestCustomer(customers, point) {
  let nearest = null;
  let best = Infinity;
  for (const c of customers) {
    const d = distanceMeters(point, c);
    if (d < best) {
      best = d;
      nearest = c;
    }
  }
  return { customer: nearest, distance: best };
}

// Describe a duration in hours, or half-days once it's over a day and a half.
function formatHours(hours) {
  if (hours < 1) return "under an hour";
  if (hours < 36) return `about ${Math.round(hours)} hours`;
  return `about ${Math.round(hours / 24 * 2) / 2} days`;
}

// Display a distance in feet, or miles for longer distances.
function formatDistance(meters) {
  const feet = meters * 3.28084;
  return feet < 1000 ? `${Math.round(feet)} ft` : `${(meters / 1609.344).toFixed(2)} mi`;
}

// Center on the coordinate bounds and expand the circle to cover every point.
function outageCircle(indices, customers) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const i of indices) {
    const point = customers[i];
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLng = Math.min(minLng, point.lng);
    maxLng = Math.max(maxLng, point.lng);
  }
  const snap = (value) => Math.round(value / OUTAGE_GRID_DEGREES) * OUTAGE_GRID_DEGREES;
  const center = {
    lat: snap(minLat + (maxLat - minLat) / 2),
    lng: snap(minLng + (maxLng - minLng) / 2),
  };
  // Cover every affected customer, with margin, but never shrink below the minimum.
  let farthest = 0;
  for (const i of indices) {
    farthest = Math.max(farthest, distanceMeters(center, customers[i]));
  }
  return { center, radius: Math.max(OUTAGE_MIN_RADIUS_M, farthest + 100) };
}

// One circle per OUTAGE_CELL_DEGREES cell that has customers from this outage.
function outageCircles(zone, customers) {
  const cells = new Map();
  for (const i of zone.customers) {
    const { lat, lng } = customers[i];
    const key = `${Math.floor(lat / OUTAGE_CELL_DEGREES)},${Math.floor(lng / OUTAGE_CELL_DEGREES)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i);
  }
  return [...cells.values()].map((indices) => outageCircle(indices, customers));
}

// Build the HTML shown when a damage marker is clicked.
function damageInfoHtml(d) {
  return `
    <div class="info">
      <strong>${d.damageType ?? "Damage"}</strong>
      <div>Asset: ${d.assetType}</div>
      ${d.simulated
      ? "<div>Generated for this storm scenario; not a reported incident.</div>"
      : `<div>Reported: ${d.reported ?? "Unknown"}</div><div>Not yet repaired</div>`}
    </div>`;
}

// Describe a damage list like "2 Pole, 1 primary".
function damageSummary(damages) {
  const counts = {};
  for (const d of damages) counts[d.assetType] = (counts[d.assetType] ?? 0) + 1;
  return Object.entries(counts).map(([type, n]) => `${n} ${type}`).join(", ") || "Unknown";
}

// Small step counts are rounded so a step can't point at one household.
function roughCustomers(n) {
  return n < 10 ? "fewer than 10" : n.toLocaleString();
}

// Title and multi-line text for an outage's side panel.
// Life-support counts and circuit IDs stay out: they are internal or could identify a household.
// Elapsed hours until a restoration step finishes: the crew's work so far plus
// the blocked-roads allowance (accessClockHours) for every repair up to and
// including it, then lunch breaks on that continuous work.
function stepDoneHours(zone, stepIndex, accessClockHours) {
  let repairs = 0;
  for (let i = 0; i <= stepIndex; i++) repairs += zone.steps[i].damages.length;
  return withLunchBreaks(zone.steps[stepIndex].workDoneHours + accessClockHours * repairs);
}

// accessClockHours: extra time per repair when roads are blocked (0 otherwise).
// Steps that restore a priority location aren't marked, so the panel can't
// point at a hospital or station; the heading explains the rule instead.
function outageDetails(zone, device, devices, accessClockHours) {
  const steps = zone.steps.length > 1
    ? [
      "",
      "Restoration steps (one crew; repairs closer to the substation first, and repairs that restore " +
        "priority locations such as hospitals before others" + (accessClockHours ? "; includes extra time for blocked roads" : "") + "):",
      ...zone.steps.map((step, i) =>
        `${i + 1}. ${devices[step.device].type} repair (${damageSummary(step.damages)}): ` +
        `${roughCustomers(step.customersRestored)} customers back in ${formatHours(stepDoneHours(zone, i, accessClockHours))}`),
    ]
    : [];
  return {
    title: `Simulated outage: ${device.type.toLowerCase()} tripped`,
    text: [
      `${zone.customers.length.toLocaleString()} customers without power`,
      `Cause: ${damageSummary(zone.damages)}`,
      `Estimated repair work: ${Math.round(zone.crewHours)} person-hours, including travel/setup`,
      ...steps,
      "",
    ].join("\n"),
  };
}

// Fit all customers in view and return their geographic bounds.
function fitToCustomers(map, customers) {
  const bounds = new google.maps.LatLngBounds();
  for (const c of customers) bounds.extend({ lat: c.lat, lng: c.lng });
  map.fitBounds(bounds);
  return bounds;
}

// Keep boundary selection and its details in sync with the panel controls.
function setupHullPanel(mapEl, onSelectionChange) {
  const panel = document.getElementById("hull-panel");
  const title = document.getElementById("hull-panel-title");
  const text = document.getElementById("hull-panel-text");
  const closeButton = document.getElementById("hull-panel-close");
  let selectedHullId = null;

  // Show the selected hull's panel, or close it when no hull is selected.
  const setPanelHull = (hullId) => {
    selectedHullId = hullId;
    const open = hullId !== null;
    panel.classList.toggle("is-open", open);
    panel.setAttribute("aria-hidden", String(!open));
    panel.inert = !open;
    onSelectionChange(hullId);
    if (open) closeButton.focus({ preventScroll: true });
    else mapEl.focus({ preventScroll: true });
  };

  // Close the panel when its close button is clicked.
  closeButton.addEventListener("click", () => setPanelHull(null));

  // Let Escape dismiss the panel while it is open.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.classList.contains("is-open")) {
      setPanelHull(null);
    }
  });

  // Show this hull's matching data, or close the panel if it is already selected.
  const toggleHullPanel = (hullId, details) => {
    if (selectedHullId !== hullId) {
      title.textContent = String(details.title ?? "");
      text.textContent = String(details.text ?? "");
    }
    setPanelHull(selectedHullId === hullId ? null : hullId);
    return true;
  };
  return toggleHullPanel;
}


// Build the visible layers. Individual customer locations are never drawn:
// sampled outages show as approximate circles over the expected forecast hexagons.
function buildLayers(search, visibility, boundaryLayers, outage) {
  const { forecast } = outage;
  const layers = [
    // Each hexagon is the average over its customers (see hexGrid.js), so dense
    // neighborhoods don't look riskier just for having more homes.
    new PolygonLayer({
      id: "storm-hexes",
      data: outage.hexes,
      visible: forecast.severity > 0,
      getPolygon: (hex) => hex.polygon,
      getFillColor: (hex) => heatColor(hex.value),
      stroked: false,
      pickable: true,
      updateTriggers: { getFillColor: forecast.severity },
    }),
    // Hide with `visible` rather than removing: deck.gl can't redraw a layer
    // object it has already removed, so the circles wouldn't come back.
    ...boundaryLayers.map((layer) => layer.clone({ visible: visibility.outages })),
    // Generated damage locations belonging to the active sampled storm.
    new ScatterplotLayer({
      id: "damage",
      data: outage.damages,
      visible: visibility.damage,
      getPosition: (d) => [d.lng, d.lat],
      getFillColor: DAMAGE_COLOR,
      getLineColor: OUTLINE_COLOR,
      stroked: true,
      lineWidthMinPixels: 2,
      getRadius: 8,
      radiusUnits: "pixels",
      pickable: true,
      onClick: outage.onDamageClick,
    }),
  ];

  if (search && visibility.nearest) {
    const { address, nearest } = search;
    layers.push(
      new LineLayer({
        id: "address-to-nearest",
        data: [{ from: address, to: nearest }],
        getSourcePosition: (d) => [d.from.lng, d.from.lat],
        getTargetPosition: (d) => [d.to.lng, d.to.lat],
        getColor: ADDRESS_COLOR,
        getWidth: 2,
      }),
      new ScatterplotLayer({
        id: "nearest",
        data: [nearest],
        getPosition: (c) => [c.lng, c.lat],
        getFillColor: TRANSPARENT_COLOR,
        getLineColor: NEAREST_COLOR,
        stroked: true,
        getLineWidth: 4,
        lineWidthUnits: "pixels",
        getRadius: 14,
        radiusUnits: "pixels",
      }),
      new ScatterplotLayer({
        id: "address",
        data: [address],
        getPosition: (a) => [a.lng, a.lat],
        getFillColor: ADDRESS_COLOR,
        getLineColor: OUTLINE_COLOR,
        stroked: true,
        getLineWidth: 2,
        lineWidthUnits: "pixels",
        getRadius: 7,
        radiusUnits: "pixels",
      }),
    );
  }

  return layers;
}

// Look up an address, favoring matches near the service area.
function geocode(geocoder, address, bounds) {
  return new Promise((resolve, reject) => {
    // Bias results toward the service area so short addresses resolve locally
    geocoder.geocode({ address, bounds }, (results, status) => {
      if (status === "OK" && results.length) resolve(results[0]);
      else if (status === "ZERO_RESULTS") reject(new Error("No results for that address."));
      else reject(new Error(`Geocoding failed (${status}). Is the Geocoding API enabled for this key?`));
    });
  });
}



// Set up the map, customer markers, legend controls, and address search.
async function initMap() {
  const mapEl = document.getElementById("map");

  if (!apiKey || apiKey === "your_api_key_here") {
    mapEl.innerHTML =
      '<p class="map-error">Missing Google Maps API key. Set VITE_GOOGLE_MAPS_API_KEY in .env and restart the dev server.</p>';
    return;
  }

  const [customers, grid, labor] = await Promise.all([
    loadCustomers(),
    loadGrid(),
    fetch("/data/labor.json").then((res) => res.json()),
    loadGoogleMaps(apiKey),
  ]);

  // Repair conditions from the storm panel's crew slider and blocked-roads box.
  // They change repair times, never which equipment fails.
  const repairConditions = { crews: CREWS, roadsBlocked: false };
  const accessLaborHours = () => (repairConditions.roadsBlocked ? labor.adders.restrictedAccess.hours : 0);
  const accessClockHours = () => repairClockHours(accessLaborHours(), grid.meta.indirectLaborMultiplier);
  const scenarioConditions = () => ({ crews: repairConditions.crews, accessLaborHours: accessLaborHours() });
  // Renamed so `new Map()` below still means JavaScript's built-in Map.
  const { Map: GoogleMap, InfoWindow } = await google.maps.importLibrary("maps");
  const { Geocoder } = await google.maps.importLibrary("geocoding");

  const map = new GoogleMap(mapEl, {
    center: DEFAULT_CENTER,
    zoom: 10,
    // Default spot (top-left) sits under the search panel
    mapTypeControlOptions: {
      position: google.maps.ControlPosition.TOP_RIGHT,
    },
    // Default spot (bottom-right) sits under the storm panel. RIGHT_TOP stacks
    // these down the right edge, just below the map-type control.
    cameraControlOptions: {
      position: google.maps.ControlPosition.RIGHT_TOP,
    },
    streetViewControlOptions: {
      position: google.maps.ControlPosition.RIGHT_TOP,
    },
  });
  const serviceBounds = fitToCustomers(map, customers);

  const infoWindow = new InfoWindow();

  // Prepare customer exposure once and start with a calm simulated storm.
  const forecastInputs = prepareForecast(grid);
  const scenarioSeed = 2026;
  let activeScenario = buildStormScenario(
    grid,
    forecastInputs,
    0,
    scenarioSeed,
  );

  // Replace these values whenever the active scenario changes.
  let { noPower, zones } = activeScenario;

  // Keep this array reference stable because the chatbot reads it too.
  const stepOfCustomer = new Int32Array(
    activeScenario.stepOfCustomer,
  );

  // Likewise, update this Map's contents instead of replacing its reference.
  const zoneByCustomer = new Map(
    activeScenario.zoneByCustomer,
  );

  // Open a damage details popup at the clicked marker.
  const showDamageInfo = ({ object }) => {
    if (!object) return;
    infoWindow.setContent(damageInfoHtml(object));
    infoWindow.setPosition({ lat: object.lat, lng: object.lng });
    infoWindow.open(map);
  };

  // Reuse the prepared exposure and initial scenario for the visible layers.
  const outage = {
    // Built once; the slider only refreshes each hexagon's average.
    hexes: buildHexGrid(customers),
    forecast: activeScenario.forecast,
    damages: activeScenario.damages,
    onDamageClick: showDamageInfo,
  };

  // Reset saved checkbox states so the legend and map both start with items off,
  // except boxes marked data-default="on" (the outage circles).
  const legendBoxes = [...document.querySelectorAll(".legend input[data-layer]")];
  const visibility = Object.fromEntries(legendBoxes.map((box) => {
    box.checked = box.dataset.default === "on";
    return [box.dataset.layer, box.checked];
  }));
  let currentSearch = null;
  let hoveredBoundaryId = null;
  let selectedBoundaryId = null;

  // Update the persistent selection when the panel opens or closes.
  const updateHullSelection = (hullId) => {
    selectedBoundaryId = hullId;
    updateBoundaryAppearance();
  };
  const toggleHullPanel = setupHullPanel(mapEl, updateHullSelection);

  // Rebuild circles and their lookups whenever the sampled outages change.
  // Rebuild circles and lookups whenever sampled outages change.
  const zoneByLayerId = new Map();
  const boundaryIds = new Set();

  function buildBoundaryLayers() {
    // Remove lookup entries belonging to the previous scenario.
    zoneByLayerId.clear();
    boundaryIds.clear();

    // Give each outage its own selectable circle.
    return zones.map((zone) => {
      const id = `outage-${zone.device}`;

      // Supply the device collection so restoration steps can be described.
      const details = outageDetails(
        zone,
        grid.devices[zone.device],
        grid.devices,
        accessClockHours(),
      );

      // Register this circle for hover and selection handling.
      zoneByLayerId.set(id, zone);
      boundaryIds.add(id);

      // Preserve the existing approximate-circle geometry and styling.
      return new ScatterplotLayer({
        id,
        data: outageCircles(zone, customers),
        getPosition: (circle) => [
          circle.center.lng,
          circle.center.lat,
        ],
        getRadius: (circle) => circle.radius,
        radiusUnits: "meters",
        stroked: true,
        getFillColor: HULL_FILL_COLOR,
        getLineColor: layerColor("--map-hull-outline"),
        getLineWidth: HULL_LINE_WIDTH,
        lineWidthUnits: "pixels",
        pickable: true,
        onClick: () => toggleHullPanel(id, details),
      });
    });
  }

  // Calm weather initially has no new damage or outage circles.
  let boundaryLayers = buildBoundaryLayers();

  // Style each hull using its own selection and hover state.
  const updateBoundaryAppearance = () => {
    boundaryLayers = boundaryLayers.map((layer) => {
      const selected = layer.id === selectedBoundaryId;
      const hovered = layer.id === hoveredBoundaryId;
      return layer.clone({
        getFillColor: selected ? HULL_SELECTED_FILL_COLOR : HULL_FILL_COLOR,
        getLineWidth: selected || hovered ? HULL_HOVER_LINE_WIDTH : HULL_LINE_WIDTH,
      });
    });
    redraw();
  };

  // Update hover styling without clearing a clicked selection.
  const updateHullHover = ({ picked, layer }) => {
    const hovered = picked && boundaryIds.has(layer?.id) ? layer.id : null;
    if (hovered === hoveredBoundaryId) return;
    hoveredBoundaryId = hovered;
    updateBoundaryAppearance();
  };

  // Show a small text box only while the hull is under the mouse.
  const hullTooltip = ({ picked, layer, object }) => {
    // Forecast hexagons describe the area average, never a household.
    if (picked && layer?.id === "storm-hexes" && object.value >= HEAT_DOMAIN[0]) {
      return { text: `Forecast: ${formatHours(object.value)} without power on average here`, className: "hull-tooltip" };
    }
    if (!picked || !boundaryIds.has(layer?.id)) return null;
    const zone = zoneByLayerId.get(layer.id);
    const device = grid.devices[zone.device];
    return {
      text: `Simulated ${device.type.toLowerCase()} outage · ${zone.customers.length.toLocaleString()} without power`,
      className: "hull-tooltip",
    };
  };

  const overlay = new GoogleMapsOverlay({
    layers: buildLayers(currentSearch, visibility, boundaryLayers, outage),
    onHover: updateHullHover,
    getTooltip: hullTooltip,
  });

  // Refresh the layers using the current checkbox choices and search result.
  const redraw = () =>
    overlay.setProps({ layers: buildLayers(currentSearch, visibility, boundaryLayers, outage) });
  overlay.setMap(map);

  // Connect each legend checkbox to its layer visibility setting.
  legendBoxes.forEach((box) => {
    box.addEventListener("change", () => {
      visibility[box.dataset.layer] = box.checked;
      // Hiding the outage circles also closes an open outage's panel.
      if (box.dataset.layer === "outages" && !box.checked && selectedBoundaryId !== null) {
        toggleHullPanel(selectedBoundaryId, {});
      }
      redraw();
    });
  });

  // Storm strength slider: one stop per named level in stormLevels.js.
  // Recompute the forecast at most once per frame.
  const stormSlider = document.getElementById("storm-severity");
  const stormValue = document.getElementById("storm-value");
  const stormSummary = document.getElementById("storm-summary");
  const heatLegend = document.getElementById("heat-legend");
  const worst = grid.meta.worstStorm;
  stormSlider.max = String(STORM_LEVELS.length - 1);
  const stormAssumptions = document.getElementById("storm-assumptions");
  const crewSlider = document.getElementById("repair-crews");
  const crewValue = document.getElementById("crews-value");
  const roadsBlockedBox = document.getElementById("roads-blocked");
  crewSlider.value = String(CREWS);
  roadsBlockedBox.checked = false;
  // The level the displayed scenario was built for.
  let activeLevel = STORM_LEVELS[0];

  let stormFrame = null;
  const updateStorm = () => {
    stormFrame = null;

    // Convert the slider's level into the severity fraction the forecast uses.
    // Build successfully before replacing the currently displayed scenario.
    const level = STORM_LEVELS[Number(stormSlider.value)];
    const severity = levelSeverity(level, worst);
    const nextScenario = buildStormScenario(grid, forecastInputs, severity, scenarioSeed, scenarioConditions());
    activeLevel = level;

    // A selected circle or open marker popup belongs to the previous outcome.
    if (selectedBoundaryId !== null) toggleHullPanel(selectedBoundaryId, {});
    hoveredBoundaryId = null;
    infoWindow.close();

    // Update the shared state used by markers, customer status, and the chatbot.
    activeScenario = nextScenario;
    noPower = activeScenario.noPower;
    zones = activeScenario.zones;
    // Refresh customer restoration steps without replacing the shared array.
    stepOfCustomer.set(activeScenario.stepOfCustomer);
    zoneByCustomer.clear();
    for (const [customer, zone] of activeScenario.zoneByCustomer) {
      zoneByCustomer.set(customer, zone);
    }

    // The heatmap retains expected values; circles and markers show one sample.
    const { forecast, summary } = activeScenario;
    outage.forecast = forecast;
    outage.damages = activeScenario.damages;
    boundaryLayers = buildBoundaryLayers();
    averageIntoHexes(outage.hexes, forecast.expectedHours);

    // Refresh an existing search without geocoding again or opening a new chat.
    renderSearchResult();
    redraw();

    // Keep aggregate counts tied to the actual displayed damage realization.
    document.getElementById("customer-count").textContent =
      `${summary.customersOut.toLocaleString()} of ${customers.length.toLocaleString()} customers without power in this simulation · ` +
      `${summary.zones} outage areas · ${summary.damages} simulated damage locations`;

    stormValue.textContent = level.name;
    crewValue.textContent = `${repairConditions.crews} crews`;
    stormAssumptions.textContent =
      "Storm strength is measured by expected broken poles and wires, compared with storms in this area's " +
      `2022-2026 damage reports. Assumes ${repairConditions.crews} crews of ${CREW_SIZE}` +
      (repairConditions.roadsBlocked ? ", with extra time per repair for blocked roads" : "") +
      ". Crews and roads change repair times, not which equipment fails. Outcomes vary between scenarios.";
    stormSlider.setAttribute("aria-valuetext", level.name);
    heatLegend.hidden = severity === 0;

    // Explain why a sampled outcome can differ from the model's expected counts.
    stormSummary.textContent = severity === 0
      ? "Calm: ordinary weather, including light rain, so no new simulated storm damage. Move the slider to generate a storm outcome."
      : `Like ${level.like}: about ${levelLineDamage(level, worst)} broken poles and wires. ` +
      `Sampled outcome: ${summary.damages} damage locations and ${summary.customersOut.toLocaleString()} customers without power. ` +
      `Forecast average: about ${Math.round(forecast.brokenPoles)} damage locations and ` +
      `${(Math.round(forecast.customersOut / 100) * 100).toLocaleString()} customers affected, typically for ${formatHours(forecast.typicalHours)}. ` +
      "The heatmap shows expected hours; circles and markers show this sampled outcome.";
  };
  stormSlider.value = "0";
  stormSlider.addEventListener("input", () => {
    if (stormFrame === null) stormFrame = requestAnimationFrame(updateStorm);
  });
  // Crew and road changes rebuild the same storm with new repair times.
  crewSlider.addEventListener("input", () => {
    repairConditions.crews = Number(crewSlider.value);
    if (stormFrame === null) stormFrame = requestAnimationFrame(updateStorm);
  });
  roadsBlockedBox.addEventListener("change", () => {
    repairConditions.roadsBlocked = roadsBlockedBox.checked;
    if (stormFrame === null) stormFrame = requestAnimationFrame(updateStorm);
  });
  // Move the slider from code (the chatbot) to a level id and redraw right away.
  const setStormLevel = (id) => {
    const index = STORM_LEVELS.findIndex((level) => level.id === id);
    if (index < 0) throw new RangeError(`Unknown storm level: ${id}`);
    if (stormFrame !== null) cancelAnimationFrame(stormFrame);
    stormSlider.value = String(index);
    updateStorm();
    return outage.forecast;
  };

  // Describe whether a customer has power, and why not.
  const powerStatus = (customer) => {
    if (!grid.customerChains[customer.index].length) {
      return "Power status unknown: no network data for this location.";
    }
    const zone = zoneByCustomer.get(customer.index);
    if (!zone) return "No outage generated for this location in the displayed storm scenario.";
    const device = grid.devices[zone.device];
    // Find the repair step that restores this customer in the active sample.
    const stepIndex = stepOfCustomer[customer.index];
    const restorationStep = zone.steps[stepIndex];

    // Describe modeled elapsed time from the start of repair work.
    const restore = restorationStep
      ? ` Modeled restoration: step ${stepIndex + 1} of ${zone.steps.length}, ${formatHours(stepDoneHours(zone, stepIndex, accessClockHours()))} after repair work starts with one crew.`
      : " Restoration-step information is unavailable.";

    // Keep simulated status, repair effort, and elapsed time distinguishable.
    return `Simulated outage: a ${device.type.toLowerCase()} tripped ` +
      `(${damageSummary(zone.damages)}), about ${Math.round(zone.crewHours)} person-hours of repair work.${restore}`;
  };

  const geocoder = new Geocoder();
  const form = document.getElementById("search-form");
  const input = document.getElementById("search-input");
  const button = form.querySelector("button");
  const resultEl = document.getElementById("search-result");

  // Show search details or an error below the address input.
  const showResult = (html, isError = false) => {
    resultEl.hidden = false;
    resultEl.classList.toggle("error", isError);
    resultEl.innerHTML = html;
  };

  // Refresh the selected address using the latest scenario, without another API call.
  function renderSearchResult() {
    // Startup has no selection, so there is no result panel to refresh yet.
    if (!currentSearch) return;
    const { nearest, distance, formattedAddress } = currentSearch;
    showResult(`
      <div><strong>${formattedAddress}</strong></div>
      <div>Nearest node: ${formatDistance(distance)} away</div>
      <div class="power-status${noPower[nearest.index] ? " no-power" : ""}">${powerStatus(nearest)}</div>
      <div class="simulation-note">${SIMULATION_NOTE}</div>
    `);
  }

  // Find an address, highlight its nearest customer on the map, and show the result.
  // Used by the search form and the chatbot's search_address tool.
  const searchAddress = async (query) => {
    const result = await geocode(geocoder, query, serviceBounds);
    const loc = result.geometry.location;
    const address = { lat: loc.lat(), lng: loc.lng() };
    const { customer: nearest, distance } = findNearestCustomer(customers, address);

    currentSearch = { address, nearest, distance, formattedAddress: result.formatted_address };
    redraw();

    const view = new google.maps.LatLngBounds();
    view.extend(address);
    view.extend({ lat: nearest.lat, lng: nearest.lng });
    map.fitBounds(view, 80);
    if (map.getZoom() > 18) map.setZoom(18);

    input.value = result.formatted_address;
    renderSearchResult();
    return { formattedAddress: result.formatted_address, customer: nearest, distance };
  };

  // Search for the address typed into the form.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;

    button.disabled = true;
    try {
      const { formattedAddress } = await searchAddress(query);
      // chatbot.js listens for this and asks the assistant for a summary.
      document.dispatchEvent(new CustomEvent("location-searched", { detail: { query, formattedAddress } }));
    } catch (err) {
      showResult(err.message, true);
    } finally {
      button.disabled = false;
    }
  });

  // Initialize after search rendering and all controls are ready.
  updateStorm();

  // Let the chatbot's tools read this map's state and drive it.
  registerMapApi({
    grid,
    forecastInputs,
    zoneByCustomer,
    stepOfCustomer,
    damageSummary,
    searchAddress,
    setStormLevel,
    getStormLevel: () => activeLevel,
    getRepairConditions: () => ({ ...repairConditions }),
    // Read completed scenario state even while an input frame is pending.
    getSeverity: () => activeScenario.severity,
    getScenario: () => activeScenario,
    getSelection: () => currentSearch && {
      customer: currentSearch.nearest,
      distance: currentSearch.distance,
      formattedAddress: currentSearch.formattedAddress,
    },
  });
}

// Show a message on the page if the map fails to start.
initMap().catch((err) => {
  console.error(err);
  document.getElementById("map").innerHTML = `<p class="map-error">${err.message}</p>`;
});
