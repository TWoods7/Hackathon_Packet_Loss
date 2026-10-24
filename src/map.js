import { GoogleMapsOverlay } from "@deck.gl/google-maps";
import { PolygonLayer, LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { rotatingCalipers } from "../scripts/boundingAlgorithm.js";

const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// Fallback center: AEP challenge service area, southwest Virginia
const DEFAULT_CENTER = { lat: 37.237, lng: -79.949 };

// Service kind codes from scripts/build-customers.js
const KIND_LABELS = ["Overhead", "Underground", "Unknown"];
// deck.gl needs numeric RGB(A) arrays; color values live in style.css.
const mapStyles = getComputedStyle(document.documentElement);
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

const EARTH_RADIUS_M = 6371000;

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

async function loadCustomers() {
  const res = await fetch("/data/customers.json");
  if (!res.ok) {
    throw new Error("Missing public/data/customers.json. Run `npm run data:customers` first.");
  }
  const { fields, rows } = await res.json();
  return rows.map((row) => Object.fromEntries(fields.map((f, i) => [f, row[i]])));
}

function distanceMeters(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Linear scan is fast enough for ~120k points (a few ms)
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

function formatDistance(meters) {
  const feet = meters * 3.28084;
  return feet < 1000 ? `${Math.round(feet)} ft` : `${(meters / 1609.344).toFixed(2)} mi`;
}

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

function fitToCustomers(map, customers) {
  const bounds = new google.maps.LatLngBounds();
  for (const c of customers) bounds.extend({ lat: c.lat, lng: c.lng });
  map.fitBounds(bounds);
  return bounds;
}

function buildLayers(customers, lifeSupport, onClick, search) {
  const layers = [
    new ScatterplotLayer({
      id: "customers",
      data: customers,
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

  if (search) {
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



async function initMap() {
  const mapEl = document.getElementById("map");

  if (!apiKey || apiKey === "your_api_key_here") {
    mapEl.innerHTML =
      '<p class="map-error">Missing Google Maps API key. Set VITE_GOOGLE_MAPS_API_KEY in .env and restart the dev server.</p>';
    return;
  }

  const [customers] = await Promise.all([loadCustomers(), loadGoogleMaps(apiKey)]);
  const { Map, InfoWindow } = await google.maps.importLibrary("maps");
  const { Geocoder } = await google.maps.importLibrary("geocoding");

  const map = new Map(mapEl, {
    center: DEFAULT_CENTER,
    zoom: 10,
    // Default spot (top-left) sits under the search panel
    mapTypeControlOptions: {
      position: google.maps.ControlPosition.TOP_RIGHT,
    },
  });
  const serviceBounds = fitToCustomers(map, customers);

  const infoWindow = new InfoWindow();
  const showInfo = ({ object }) => {
    if (!object) return;
    infoWindow.setContent(customerInfoHtml(object));
    infoWindow.setPosition({ lat: object.lat, lng: object.lng });
    infoWindow.open(map);
  };

  const lifeSupport = customers.filter((c) => c.lifeSupport);

  const overlay = new GoogleMapsOverlay({
    layers: [
      //rotatingCalipers(customers.map((c) => [c.lng, c.lat])),
      new ScatterplotLayer({
        id: "customers",
        data: customers,
        getPosition: (c) => [c.lng, c.lat],
        getFillColor: (c) => KIND_COLORS[c.kind],
        getRadius: 6,
        radiusUnits: "meters",
        radiusMinPixels: 1.5,
        radiusMaxPixels: 8,
        opacity: 0.7,
        pickable: true,
        onClick: showInfo,
      }),
      new ScatterplotLayer({
        id: "life-support",
        data: lifeSupport,
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
        onClick: showInfo,
      }),
    ],
  });
  overlay.setMap(map);

  document.getElementById("customer-count").textContent =
    `${customers.length.toLocaleString()} customers · ${lifeSupport.length} life support`;

  const geocoder = new Geocoder();
  const form = document.getElementById("search-form");
  const input = document.getElementById("search-input");
  const button = form.querySelector("button");
  const resultEl = document.getElementById("search-result");

  const showResult = (html, isError = false) => {
    resultEl.hidden = false;
    resultEl.classList.toggle("error", isError);
    resultEl.innerHTML = html;
  };

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

      overlay.setProps({ layers: buildLayers(customers, lifeSupport, showInfo, { address, nearest }) });

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

initMap().catch((err) => {
  console.error(err);
  document.getElementById("map").innerHTML = `<p class="map-error">${err.message}</p>`;
});
