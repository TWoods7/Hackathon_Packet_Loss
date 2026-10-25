import assert from "node:assert/strict";
import test from "node:test";
import {
  averageIntoHexes,
  buildHexGrid,
  HEX_MIN_CUSTOMERS,
  isPointInHexGrid,
} from "../src/hexGrid.js";

// Distinct groups share a latitude so the grid's projection stays consistent.
function customersAt(lng, count, firstIndex = 0) {
  return Array.from({ length: count }, (_, offset) => ({
    index: firstIndex + offset,
    lng,
    lat: 37,
  }));
}

// Compute test positions from the actual polygons rather than copying grid math.
function centerOf(hex) {
  return {
    lng: hex.polygon.reduce((sum, corner) => sum + corner[0], 0) / hex.polygon.length,
    lat: hex.polygon.reduce((sum, corner) => sum + corner[1], 0) / hex.polygon.length,
  };
}

function moveFromCenter(center, point, scale) {
  return {
    lng: center.lng + (point.lng - center.lng) * scale,
    lat: center.lat + (point.lat - center.lat) * scale,
  };
}

test("included grid cells cover their centers, corners, and edge midpoints", () => {
  const customers = customersAt(-80, HEX_MIN_CUSTOMERS);
  const hexes = buildHexGrid(customers);
  assert.equal(hexes.length, 1);
  const [hex] = hexes;
  const center = centerOf(hex);
  assert.equal(isPointInHexGrid(center, hexes), true);
  assert.equal(isPointInHexGrid(customers[0], hexes), true);

  for (let index = 0; index < hex.polygon.length; index++) {
    const [lng, lat] = hex.polygon[index];
    const next = hex.polygon[(index + 1) % hex.polygon.length];
    const midpoint = { lng: (lng + next[0]) / 2, lat: (lat + next[1]) / 2 };
    assert.equal(isPointInHexGrid({ lng, lat }, hexes), true, `corner ${index}`);
    assert.equal(isPointInHexGrid(midpoint, hexes), true, `edge ${index}`);
    assert.equal(isPointInHexGrid(moveFromCenter(center, midpoint, 0.99), hexes), true, `inside edge ${index}`);
    assert.equal(isPointInHexGrid(moveFromCenter(center, midpoint, 1.01), hexes), false, `outside edge ${index}`);
  }
});

test("coverage follows the union of included tiles rather than its bounding rectangle", () => {
  const customers = [
    ...customersAt(-80, HEX_MIN_CUSTOMERS),
    ...customersAt(-79.94, HEX_MIN_CUSTOMERS, HEX_MIN_CUSTOMERS),
  ];
  const hexes = buildHexGrid(customers);
  assert.equal(hexes.length, 2);
  for (const hex of hexes) assert.equal(isPointInHexGrid(centerOf(hex), hexes), true);
  assert.equal(isPointInHexGrid({ lng: -79.97, lat: 37 }, hexes), false);
  assert.equal(isPointInHexGrid({ lng: -78, lat: 38 }, hexes), false);
  assert.equal(isPointInHexGrid({ lng: -80, lat: 37 }, []), false);
});

test("a tile with fewer than ten customers does not create coverage", () => {
  assert.equal(HEX_MIN_CUSTOMERS, 10);
  const included = customersAt(-80, HEX_MIN_CUSTOMERS);
  const omitted = customersAt(-79.97, HEX_MIN_CUSTOMERS - 1, HEX_MIN_CUSTOMERS);
  const hexes = buildHexGrid([...included, ...omitted]);
  assert.equal(hexes.length, 1);
  assert.equal(isPointInHexGrid(included[0], hexes), true);
  assert.equal(isPointInHexGrid(omitted[0], hexes), false);

  // Adding the tenth customer includes that same area without moving its points.
  const full = buildHexGrid([...included, ...omitted, { index: 19, lng: -79.97, lat: 37 }]);
  assert.equal(full.length, 2);
  assert.equal(isPointInHexGrid(omitted[0], full), true);
});

test("calm or changed forecast values do not remove geographic coverage", () => {
  const customers = customersAt(-80, HEX_MIN_CUSTOMERS);
  const hexes = buildHexGrid(customers);
  const center = centerOf(hexes[0]);
  averageIntoHexes(hexes, new Float32Array(HEX_MIN_CUSTOMERS));
  assert.equal(hexes[0].value, 0);
  assert.equal(isPointInHexGrid(center, hexes), true);
  averageIntoHexes(hexes, new Float32Array(HEX_MIN_CUSTOMERS).fill(48));
  assert.equal(hexes[0].value, 48);
  assert.equal(isPointInHexGrid(center, hexes), true);
});
