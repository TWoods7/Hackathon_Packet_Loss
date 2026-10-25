// Hexagon grid for the storm forecast, so the map shows area averages instead of homes.
// Hexagons with too few customers are left out so a value can't point at one household.

// Hexagon size (center to corner) and the fewest customers a hexagon needs to be shown.
export const HEX_RADIUS_M = 300;
export const HEX_MIN_CUSTOMERS = 10;

const METERS_PER_DEGREE_LAT = 110540;
const SQRT3 = Math.sqrt(3);

// Round fractional axial coordinates to the hexagon that contains them.
function roundAxial(q, r) {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq, rr];
}

// Group customers into pointy-top hexagons and return the ones big enough to show.
// Each hexagon: { polygon: [[lng, lat] x 6], customers: [customer index, ...] }.
export function buildHexGrid(customers) {
  // Flat projection around the area's middle latitude (fine at city scale).
  const midLat = customers.reduce((sum, c) => sum + c.lat, 0) / customers.length;
  const metersPerDegreeLng = 111320 * Math.cos((midLat * Math.PI) / 180);
  const toMeters = (c) => [c.lng * metersPerDegreeLng, c.lat * METERS_PER_DEGREE_LAT];
  const toLngLat = ([x, y]) => [x / metersPerDegreeLng, y / METERS_PER_DEGREE_LAT];

  const cells = new Map();
  for (const c of customers) {
    const [x, y] = toMeters(c);
    const [q, r] = roundAxial(
      ((SQRT3 / 3) * x - y / 3) / HEX_RADIUS_M,
      ((2 / 3) * y) / HEX_RADIUS_M,
    );
    const key = `${q},${r}`;
    if (!cells.has(key)) cells.set(key, { q, r, customers: [] });
    cells.get(key).customers.push(c.index);
  }

  const hexes = [];
  for (const { q, r, customers: members } of cells.values()) {
    if (members.length < HEX_MIN_CUSTOMERS) continue;
    const cx = HEX_RADIUS_M * SQRT3 * (q + r / 2);
    const cy = HEX_RADIUS_M * 1.5 * r;
    const polygon = [0, 1, 2, 3, 4, 5].map((corner) => {
      const angle = (Math.PI / 180) * (60 * corner - 30);
      return toLngLat([cx + HEX_RADIUS_M * Math.cos(angle), cy + HEX_RADIUS_M * Math.sin(angle)]);
    });
    hexes.push({ polygon, customers: members, value: 0 });
  }
  return hexes;
}

// Check the actual tile polygons, counting points on their edges as covered.
export function isPointInHexGrid(point, hexes) {
  return hexes.some(({ polygon }) => {
    let side = 0;
    for (let i = 0; i < polygon.length; i++) {
      const [ax, ay] = polygon[i];
      const [bx, by] = polygon[(i + 1) % polygon.length];
      const cross = (bx - ax) * (point.lat - ay) - (by - ay) * (point.lng - ax);
      // Allow for floating-point rounding along shared edges.
      if (Math.abs(cross) <= 1e-12) continue;
      const nextSide = Math.sign(cross);
      if (side && side !== nextSide) return false;
      side = nextSide;
    }
    return true;
  });
}

// Average a per-customer value (e.g. expected hours without power) into each hexagon.
export function averageIntoHexes(hexes, values) {
  for (const hex of hexes) {
    let sum = 0;
    for (const i of hex.customers) sum += values[i];
    hex.value = sum / hex.customers.length;
  }
  return hexes;
}
