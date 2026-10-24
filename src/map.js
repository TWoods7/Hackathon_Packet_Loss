import { GoogleMapsOverlay } from "@deck.gl/google-maps";
import { LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { rotatingCalipers } from "../scripts/boundingAlgorithm.js";

const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// Fallback center: AEP challenge service area, southwest Virginia
const DEFAULT_CENTER = { lat: 37.237, lng: -79.949 };

// Service kind codes from scripts/build-customers.js
const KIND_LABELS = ["Overhead", "Underground", "Unknown"];
// Legend checkbox keys for each kind code; must match data-layer in map.html
const KIND_KEYS = ["overhead", "underground", "unknown"];

// deck.gl needs numeric RGB(A) arrays; color values live in style.css.
const mapStyles = getComputedStyle(document.documentElement);
// Read a CSS color as the numeric array deck.gl needs.
function layerColor(property) {
  return mapStyles.getPropertyValue(property).trim().split(",").map(Number);
}
const KIND_COLORS = [
  layerColor("--map-overhead"),
  layerColor("--map-underground"),
  layerColor("--map-unknown"),
];
const LIFE_SUPPORT_COLOR = layerColor("--map-life-support");
const NEAREST_COLOR = layerColor("--map-nearest");
const ADDRESS_COLOR = layerColor("--map-address");
const OUTLINE_COLOR = layerColor("--map-outline");
const TRANSPARENT_COLOR = layerColor("--map-transparent");
const HULL_FILL_COLOR = layerColor("--map-hull-fill");
const HULL_SELECTED_FILL_COLOR = layerColor("--map-hull-selected-fill");
const HULL_LINE_WIDTH = Number(mapStyles.getPropertyValue("--map-hull-line-width"));
const HULL_HOVER_LINE_WIDTH = Number(mapStyles.getPropertyValue("--map-hull-hover-line-width"));

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
  return rows.map((row) => Object.fromEntries(fields.map((f, i) => [f, row[i]])));
}

// Load the boundary groups and their matching titles and text.
async function loadTestData() {
  // A full URL prevents Vite from adding ?import to this public-file request.
  const url = new URL(`${import.meta.env.BASE_URL}data/testData.js`, window.location.href).href;
  return import(/* @vite-ignore */ url);
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

// Display a distance in feet, or miles for longer distances.
function formatDistance(meters) {
  const feet = meters * 3.28084;
  return feet < 1000 ? `${Math.round(feet)} ft` : `${(meters / 1609.344).toFixed(2)} mi`;
}

// Build the HTML shown when a customer marker is clicked.
function customerInfoHtml(c) {
  return `
    <div class="info">
      <strong>${c.location || "Customer"}</strong>
      <div>Service: ${KIND_LABELS[c.kind]}</div>
      <div>Customers at point: ${c.customerCount}</div>
      <div>Circuit: ${c.circuitId}</div>
      <div>Transformer: ${c.transformer}</div>
      <div>Premise: ${c.premise}</div>
      ${c.lifeSupport ? '<div class="life-support">Life support customer</div>' : ""}
    </div>`;
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


// Build the visible marker and search layers while keeping all boundaries.
function buildLayers(customers, lifeSupport, onClick, search, visibility, boundaryLayers) {
  // Filtering ~120k points takes a few ms, so it's fine to redo on every toggle
  const shownCustomers = customers.filter((c) => visibility[KIND_KEYS[c.kind]]);

  const layers = [
    ...boundaryLayers,
    new ScatterplotLayer({
      id: "customers",
      data: shownCustomers,
      getPosition: (c) => [c.lng, c.lat],
      getFillColor: (c) => KIND_COLORS[c.kind],
      getRadius: 6,
      radiusUnits: "meters",
      radiusMinPixels: 1.5,
      radiusMaxPixels: 8,
      opacity: 0.7,
      pickable: true,
      onClick,
    }),
    new ScatterplotLayer({
      id: "life-support",
      data: lifeSupport,
      visible: visibility.lifeSupport,
      getPosition: (c) => [c.lng, c.lat],
      getFillColor: LIFE_SUPPORT_COLOR,
      getLineColor: OUTLINE_COLOR,
      stroked: true,
      lineWidthMinPixels: 1,
      getRadius: 20,
      radiusUnits: "meters",
      radiusMinPixels: 5,
      radiusMaxPixels: 14,
      pickable: true,
      onClick,
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
        pickable: true,
        onClick,
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

  const [customers, testData] = await Promise.all([
    loadCustomers(),
    loadTestData(),
    loadGoogleMaps(apiKey),
  ]);
  const { testBounds, testFloats, testText } = testData;
  const { Map, InfoWindow } = await google.maps.importLibrary("maps");
  const { Geocoder } = await google.maps.importLibrary("geocoding");

  const map = new Map(mapEl, {
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
  // Open a customer details popup at the clicked marker.
  const showInfo = ({ object }) => {
    if (!object) return;
    infoWindow.setContent(customerInfoHtml(object));
    infoWindow.setPosition({ lat: object.lat, lng: object.lng });
    infoWindow.open(map);
  };

  const lifeSupport = customers.filter((c) => c.lifeSupport);

  // Reset saved checkbox states so the legend and map both start with items off.
  const legendBoxes = [...document.querySelectorAll(".legend input[data-layer]")];
  const visibility = Object.fromEntries(legendBoxes.map((box) => {
    box.checked = false;
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

  // Create one reusable hull layer for each testBounds group.
  let boundaryLayers = testBounds.map((coordinates, index) => {
    const id = `test-boundary-${index + 1}`;
    return rotatingCalipers(coordinates, {
      id,
      getFillColor: HULL_FILL_COLOR,
      getLineColor: layerColor("--map-hull-outline"),
      getLineWidth: HULL_LINE_WIDTH,
      lineWidthUnits: "pixels",
      // Match the panel title and text to this hull's index in testBounds.
      onClick: () => toggleHullPanel(id, {
        title: testFloats[index],
        text: testText[index],
      }),
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
  const hullTooltip = ({ picked, layer }) =>
    picked && boundaryIds.has(layer?.id)
      ? { text: "test", className: "hull-tooltip" }
      : null;

  const overlay = new GoogleMapsOverlay({
    layers: buildLayers(customers, lifeSupport, showInfo, currentSearch, visibility, boundaryLayers),
    onHover: updateHullHover,
    getTooltip: hullTooltip,
  });

  // Refresh the layers using the current checkbox choices and search result.
  const redraw = () =>
    overlay.setProps({ layers: buildLayers(customers, lifeSupport, showInfo, currentSearch, visibility, boundaryLayers) });
  overlay.setMap(map);

  // Connect each legend checkbox to its layer visibility setting.
  legendBoxes.forEach((box) => {
    box.addEventListener("change", () => {
      visibility[box.dataset.layer] = box.checked;
      redraw();
    });
  });


  document.getElementById("customer-count").textContent =
    `${customers.length.toLocaleString()} customers · ${lifeSupport.length} life support`;

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

  // Find the entered address and highlight its nearest customer on the map.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;

    button.disabled = true;
    try {
      const result = await geocode(geocoder, query, serviceBounds);
      const loc = result.geometry.location;
      const address = { lat: loc.lat(), lng: loc.lng() };
      const { customer: nearest, distance } = findNearestCustomer(customers, address);

      currentSearch = { address, nearest };
      redraw();

      const view = new google.maps.LatLngBounds();
      view.extend(address);
      view.extend({ lat: nearest.lat, lng: nearest.lng });
      map.fitBounds(view, 80);
      if (map.getZoom() > 18) map.setZoom(18);

      showResult(`
        <div><strong>${result.formatted_address}</strong></div>
        <div>Nearest node: ${formatDistance(distance)} away</div>
        <div>Service: ${KIND_LABELS[nearest.kind]} · Circuit ${nearest.circuitId}</div>
        <div>Transformer: ${nearest.transformer}</div>
      `);
    } catch (err) {
      showResult(err.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

// Show a message on the page if the map fails to start.
initMap().catch((err) => {
  console.error(err);
  document.getElementById("map").innerHTML = `<p class="map-error">${err.message}</p>`;
});
