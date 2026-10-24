const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// Default center: Ohio State University, Columbus OH
const DEFAULT_CENTER = { lat: 40.0067, lng: -83.0305 };

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

async function initMap() {
  const mapEl = document.getElementById("map");

  if (!apiKey || apiKey === "your_api_key_here") {
    mapEl.innerHTML =
      '<p class="map-error">Missing Google Maps API key. Set VITE_GOOGLE_MAPS_API_KEY in .env and restart the dev server.</p>';
    return;
  }

  await loadGoogleMaps(apiKey);
  const { Map } = await google.maps.importLibrary("maps");
  const { Marker } = await google.maps.importLibrary("marker");

  const map = new Map(mapEl, {
    center: DEFAULT_CENTER,
    zoom: 15,
  });

  new Marker({ position: DEFAULT_CENTER, map, title: "Ohio State" });
}

initMap().catch((err) => {
  console.error(err);
  document.getElementById("map").innerHTML = `<p class="map-error">${err.message}</p>`;
});
