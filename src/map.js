import { GoogleMapsOverlay } from "@deck.gl/google-maps";
import { LineLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { buildHexGrid, averageIntoHexes } from "./hexGrid.js";
import {
  loadGrid,
  trippedDevices,
  computeOutages,
  prepareForecast,
  stormForecast,
} from "./outages.js";
import { CREWS, CREW_SIZE } from "./restorationModel.js";
import { registerMapApi } from "./assistantTools.js";

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

// Shown wherever outage results appear: the data has no live outage feed.
const SIMULATION_NOTE = "Simulated from unrepaired damage reports, not live outage data.";

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
function outageCircle(zone, customers) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const i of zone.customers) {
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
  for (const i of zone.customers) {
    farthest = Math.max(farthest, distanceMeters(center, customers[i]));
  }
  return { center, radius: Math.max(OUTAGE_MIN_RADIUS_M, farthest + 100) };
}

// Build the HTML shown when a damage marker is clicked.
function damageInfoHtml(d) {
  return `
    <div class="info">
      <strong>${d.damageType ?? "Damage"}</strong>
      <div>Asset: ${d.assetType}</div>
      <div>Reported: ${d.reported ?? "Unknown"}</div>
      <div>Not yet repaired</div>
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
function outageDetails(zone, device, devices) {
  const steps = zone.steps.length > 1
    ? [
        "",
        "Restoration steps (one crew, repairs closer to the substation first):",
        ...zone.steps.map((step, i) =>
          `${i + 1}. ${devices[step.device].type} repair (${damageSummary(step.damages)}): ` +
          `${roughCustomers(step.customersRestored)} customers back in ${formatHours(step.doneAfterHours)}`),
      ]
    : [];
  return {
    title: `Outage: ${device.type.toLowerCase()} tripped`,
    text: [
      `${zone.customers.length.toLocaleString()} customers without power`,
      `Cause: ${damageSummary(zone.damages)}`,
      `Estimated repair: ${Math.round(zone.crewHours)} crew-hours`,
      ...steps,
      "",
      SIMULATION_NOTE,
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
    console.log("clicked");
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
// today's outages show as approximate circles over the storm forecast hexagons.
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
    // Damaged equipment that hasn't been repaired.
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

  const [customers, grid] = await Promise.all([
    loadCustomers(),
    loadGrid(),
    loadGoogleMaps(apiKey),
  ]);
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
    // Default spot (bottom-right) sits under the chatbot
    cameraControlOptions: {
      position: google.maps.ControlPosition.RIGHT_CENTER,
    },
    streetViewControlOptions: {
      position: google.maps.ControlPosition.RIGHT_CENTER,
    },
  });
  const serviceBounds = fitToCustomers(map, customers);

  const infoWindow = new InfoWindow();

  // Work out today's outages from the unrepaired damage.
  const { noPower, zones, stepOfCustomer } = computeOutages(grid, trippedDevices(grid.damages), grid.damages);
  const zoneByCustomer = new Map();
  for (const zone of zones) for (const i of zone.customers) zoneByCustomer.set(i, zone);

  // Open a damage details popup at the clicked marker.
  const showDamageInfo = ({ object }) => {
    if (!object) return;
    infoWindow.setContent(damageInfoHtml(object));
    infoWindow.setPosition({ lat: object.lat, lng: object.lng });
    infoWindow.open(map);
  };

  // The storm forecast starts calm; the severity slider updates it.
  const forecastInputs = prepareForecast(grid);
  const outage = {
    // Built once; the slider only refreshes each hexagon's average.
    hexes: buildHexGrid(customers),
    forecast: stormForecast(grid, forecastInputs, 0),
    damages: grid.damages,
    onDamageClick: showDamageInfo,
  };
  const customersWithoutPower = noPower.reduce((sum, value) => sum + value, 0);

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

  // Create one approximate orange circle per outage (see outageCircle).
  // Each is its own layer so the hover/selection styling below works per outage.
  const zoneByLayerId = new Map();
  let boundaryLayers = zones.map((zone) => {
    const id = `outage-${zone.device}`;
    const details = outageDetails(zone, grid.devices[zone.device], grid.devices);
    zoneByLayerId.set(id, zone);
    return new ScatterplotLayer({
      id,
      data: [outageCircle(zone, customers)],
      getPosition: (circle) => [circle.center.lng, circle.center.lat],
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
  const boundaryIds = new Set(boundaryLayers.map((layer) => layer.id));

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
      text: `${device.type} outage · ${zone.customers.length.toLocaleString()} without power`,
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

  // Storm severity slider: recompute the forecast at most once per frame.
  const stormSlider = document.getElementById("storm-severity");
  const stormValue = document.getElementById("storm-value");
  const stormSummary = document.getElementById("storm-summary");
  const heatLegend = document.getElementById("heat-legend");
  const worst = grid.meta.worstStorm;
  document.getElementById("storm-assumptions").textContent =
    `Forecast model, not confirmed outages. 100% = the ${worst.start} to ${worst.end} storm ` +
    `(${worst.lineDamage} broken poles and wires). Assumes ${CREWS} repair crews of ${CREW_SIZE}.`;

  let stormFrame = null;
  const updateStorm = () => {
    stormFrame = null;
    const severity = Number(stormSlider.value) / 100;
    const forecast = stormForecast(grid, forecastInputs, severity);
    outage.forecast = forecast;
    averageIntoHexes(outage.hexes, forecast.expectedHours);
    redraw();

    stormValue.textContent = `${stormSlider.value}%`;
    heatLegend.hidden = severity === 0;
    // Round customer counts to the nearest hundred: this is an estimate, not a tally.
    const people = forecast.customersOut < 100
      ? "Fewer than 100"
      : `About ${(Math.round(forecast.customersOut / 100) * 100).toLocaleString()}`;
    stormSummary.textContent = severity === 0
      ? "Calm weather: no storm damage expected. Move the slider to forecast a storm."
      : `About ${Math.round(forecast.brokenPoles).toLocaleString()} broken poles and wires. ` +
        `${people} customers likely lose power, typically for ${formatHours(forecast.typicalHours)}.`;
  };
  stormSlider.value = "0";
  stormSlider.addEventListener("input", () => {
    if (stormFrame === null) stormFrame = requestAnimationFrame(updateStorm);
  });
  // Move the slider from code (the chatbot) and redraw right away.
  const setStormSeverity = (percent) => {
    if (stormFrame !== null) cancelAnimationFrame(stormFrame);
    stormSlider.value = String(percent);
    updateStorm();
    return outage.forecast;
  };
  updateStorm();


  document.getElementById("customer-count").textContent =
    `${customersWithoutPower.toLocaleString()} of ${customers.length.toLocaleString()} customers without power · ` +
    `${zones.length} outages`;

  // Describe whether a customer has power, and why not.
  const powerStatus = (customer) => {
    if (!grid.customerChains[customer.index].length) {
      return "Power status unknown: no network data for this location.";
    }
    const zone = zoneByCustomer.get(customer.index);
    if (!zone) return "Power on: no reported damage upstream of this location.";
    const device = grid.devices[zone.device];
    const step = stepOfCustomer[customer.index];
    const restore = zone.steps.length > 1
      ? ` Restored at step ${step + 1} of ${zone.steps.length}, power back in ${formatHours(zone.steps[step].doneAfterHours)}.`
      : "";
    return `No power: inside a ${device.type.toLowerCase()} outage ` +
      `(${damageSummary(zone.damages)}), about ${Math.round(zone.crewHours)} crew-hours of repair.${restore}`;
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
    showResult(`
      <div><strong>${result.formatted_address}</strong></div>
      <div>Nearest node: ${formatDistance(distance)} away</div>
      <div class="power-status${noPower[nearest.index] ? " no-power" : ""}">${powerStatus(nearest)}</div>
      <div class="simulation-note">${SIMULATION_NOTE}</div>
    `);
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

  // Let the chatbot's tools read this map's state and drive it.
  registerMapApi({
    grid,
    forecastInputs,
    zoneByCustomer,
    stepOfCustomer,
    damageSummary,
    searchAddress,
    setStormSeverity,
    getSeverity: () => Number(stormSlider.value) / 100,
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
