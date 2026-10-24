import { PolygonLayer } from "@deck.gl/layers";

/**
 * Return the convex hull as counterclockwise [x, y] coordinates, starting
 * at the lexicographically smallest point, without repeating the first point.
 * Uses the monotone chain algorithm in O(n log n); the public function name
 * is retained for existing callers. Does not mutate the input.
 * Removes duplicates and intermediate collinear points. Empty input returns [];
 * a single point returns [point], and collinear input returns its endpoints.
 * @param {Array<[number, number]>} coordinates Finite planar coordinate tuples.
 * @returns {PolygonLayer}
 */
export function rotatingCalipers(coordinates) {
  if (!Array.isArray(coordinates)) {
    throw new TypeError('coordinates must be an array of [x, y] tuples');
  }
  const points = coordinates.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 ||
        !point.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new TypeError('Each coordinate must be a [x, y] tuple of finite numbers');
    }
    return [...point];
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const unique = points.filter((p, i) =>
    i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  if (unique.length <= 2) return unique;

  const cross = (a, b, c) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const halfHull = (ordered) => {
    const half = [];
    for (const p of ordered) {
      while (half.length >= 2 && cross(half[half.length - 2], half[half.length - 1], p) <= 0) {
        half.pop();
      }
      half.push(p);
    }
    half.pop();
    return half;
  };
  return createBoundingOverlay([...halfHull(unique), ...halfHull([...unique].reverse())]);
}

/**
 * Create a deck.gl shape layer from rotatingCalipers() output.
 * The ordered hull must use [longitude, latitude] coordinates.
 * Hulls with fewer than three vertices produce an empty layer.
 */
export function createBoundingOverlay(hull) {
  return new PolygonLayer({
    id: "customer-convex-hull",
    data: hull.length >= 3 ? [hull] : [],
    getPolygon: (coordinates) => coordinates,
    getFillColor: [37, 99, 235, 30],
    getLineColor: [37, 99, 235],
    filled: true,
    stroked: true,
    lineWidthMinPixels: 2,
    pickable: false,
  });
}