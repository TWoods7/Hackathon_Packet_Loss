import { PolygonLayer } from "@deck.gl/layers";

/**
 * Build a map layer around the outermost points without changing the input.
 * With two or fewer unique points, return their coordinates instead of a layer.
 * @param {Array<[number, number]>} coordinates Finite planar coordinate tuples.
 * @param {object} layerProps Optional colors and settings for the map layer.
 * @returns {PolygonLayer|Array<[number, number]>}
 */
export function rotatingCalipers(coordinates, layerProps = {}) {
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

  // Check whether three points turn left, turn right, or lie on one line.
  const cross = (a, b, c) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  // Build one side of the boundary, dropping points inside it or along an edge.
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
  return createBoundingOverlay([...halfHull(unique), ...halfHull([...unique].reverse())], layerProps);
}

/**
 * Draw an ordered [longitude, latitude] boundary as a filled map polygon.
 * Fewer than three vertices produce an empty layer.
 */
export function createBoundingOverlay(hull, layerProps = {}) {
  return new PolygonLayer({
    id: "customer-convex-hull",
    data: hull.length >= 3 ? [hull] : [],
    getPolygon: (coordinates) => coordinates,
    filled: true,
    stroked: true,
    lineWidthMinPixels: 2,
    pickable: true,
    // Log when the hull is clicked.
    onClick: () => console.log("clicked"),
    ...layerProps,
  });
}
