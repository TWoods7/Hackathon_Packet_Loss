import { GoogleMapsOverlay } from "@deck.gl/google-maps";
import { ScatterplotLayer } from "@deck.gl/layers";

const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// Fallback center: AEP challenge service area, southwest Virginia
const DEFAULT_CENTER = { lat: 37.237, lng: -79.949 };

// Service kind codes from scripts/build-customers.js
const KIND_LABELS = ["Overhead", "Underground", "Unknown"];
const KIND_COLORS = [
  [37, 99, 235],
  [22, 163, 74],
  [140, 140, 150],
];
const LIFE_SUPPORT_COLOR = [220, 38, 38];

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

  const map = new Map(mapEl, {
    center: DEFAULT_CENTER,
    zoom: 10,
  });
  fitToCustomers(map, customers);

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
        getLineColor: [255, 255, 255],
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
}

initMap().catch((err) => {
  console.error(err);
  document.getElementById("map").innerHTML = `<p class="map-error">${err.message}</p>`;
});
