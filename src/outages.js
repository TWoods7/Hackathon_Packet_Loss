// Outage engine: decide which customers lose power when devices trip.
// Data comes from public/data/grid.json (npm run data:grid).
// Every time formula comes from restorationModel.js.
import {
  crewHours,
  repairClockHours,
  failureChance,
  stormClearHours,
  hoursWithoutPower,
  expectedHoursWithoutPower,
} from "./restorationModel.js";

// Turn a { fields, rows } table into an array of objects.
function rowsToObjects({ fields, rows }) {
  return rows.map((row) => Object.fromEntries(fields.map((f, i) => [f, row[i]])));
}

// Fetch the outage grid and unpack its tables.
export async function loadGrid() {
  const res = await fetch("/data/grid.json");
  if (!res.ok) {
    throw new Error("Missing public/data/grid.json. Run `npm run data:grid` first.");
  }
  const grid = await res.json();
  return {
    meta: grid.meta,
    devices: rowsToObjects(grid.devices),
    customerChains: grid.customerChains,
    candidates: grid.candidates.rows,
    damages: rowsToObjects(grid.damages),
  };
}

// Devices tripped by a list of damages (damages that cut nobody's power are skipped).
export function trippedDevices(damages) {
  return new Set(damages.map((d) => d.device).filter((d) => d != null));
}

// Work out who has no power and group them into one zone per outage.
// A customer belongs to the most upstream tripped device in its chain,
// so an outage nested inside a bigger one merges into the bigger zone.
export function computeOutages(grid, tripped, damages) {
  const noPower = new Uint8Array(grid.customerChains.length);
  const zonesByDevice = new Map();

  grid.customerChains.forEach((chain, customer) => {
    // Chains run transformer -> substation, so the last tripped device is the most upstream.
    let cause = null;
    for (const device of chain) if (tripped.has(device)) cause = device;
    if (cause === null) return;

    noPower[customer] = 1;
    if (!zonesByDevice.has(cause)) zonesByDevice.set(cause, { device: cause, customers: [], damages: [] });
    zonesByDevice.get(cause).customers.push(customer);
  });

  // Attach each damage to the zone whose customers it affects.
  const zoneOfDevice = new Map();
  for (const zone of zonesByDevice.values()) {
    for (const customer of zone.customers) {
      for (const device of grid.customerChains[customer]) zoneOfDevice.set(device, zone);
    }
  }
  for (const damage of damages) {
    zoneOfDevice.get(damage.device)?.damages.push(damage);
  }

  // Crew-hours of repair work for each outage (formula in restorationModel.js).
  const multiplier = grid.meta.indirectLaborMultiplier;
  const zones = [...zonesByDevice.values()].map((zone) => ({
    ...zone,
    crewHours: crewHours(zone.damages.reduce((sum, d) => sum + (d.directHours ?? 0), 0), multiplier),
  }));
  zones.sort((a, b) => b.customers.length - a.customers.length);

  return { noPower, zones };
}

// ---------------------------------------------------------------------------
// Storm forecast: chance of losing power and expected hours without power.
// The formulas themselves live in restorationModel.js.
// ---------------------------------------------------------------------------

// Precompute per-customer totals once; the slider then only rescales them.
export function prepareForecast(grid) {
  // Per device: summed failure weight of the poles behind it, and weighted repair hours.
  const deviceWeight = new Float64Array(grid.devices.length);
  const deviceWeightedHours = new Float64Array(grid.devices.length);
  for (const [, , device, weight, hours] of grid.candidates) {
    deviceWeight[device] += weight;
    deviceWeightedHours[device] += weight * hours;
  }

  // Per customer: every pole that can cut its power is behind some device in its chain.
  const customers = grid.customerChains.length;
  const exposure = new Float64Array(customers);
  const repairHours = new Float64Array(customers);
  grid.customerChains.forEach((chain, i) => {
    let weight = 0;
    let weightedHours = 0;
    for (const device of chain) {
      weight += deviceWeight[device];
      weightedHours += deviceWeightedHours[device];
    }
    exposure[i] = weight;
    repairHours[i] = weight ? weightedHours / weight : 0;
  });

  return { exposure, repairHours };
}

// Forecast outages for a storm severity from 0 (calm) to 1 (the worst storm in the data).
// crews: optional repair-crew count; defaults to CREWS in restorationModel.js.
export function stormForecast(grid, prepared, severity, crews) {
  const customers = grid.customerChains.length;
  const expectedHours = new Float32Array(customers);
  const result = { severity, scale: 0, expectedHours, brokenPoles: 0, customersOut: 0, typicalHours: 0, stormClearHours: 0 };
  if (severity <= 0) return result;

  // Find the storm scale that breaks, on average, the requested share of the
  // worst storm's poles and wires.
  const target = severity * grid.meta.worstStorm.lineDamage;
  const expectedFailures = (scale) =>
    grid.candidates.reduce((sum, row) => sum + failureChance(scale, row[3]), 0);
  let low = 0;
  let high = 1;
  while (expectedFailures(high) < target) high *= 2;
  for (let step = 0; step < 40; step++) {
    const mid = (low + high) / 2;
    if (expectedFailures(mid) < target) low = mid;
    else high = mid;
  }
  const scale = high;

  // Total clock time of every expected repair, then how long all crews need for it.
  const multiplier = grid.meta.indirectLaborMultiplier;
  const totalClockHours = grid.candidates.reduce(
    (sum, row) => sum + failureChance(scale, row[3]) * repairClockHours(row[4], multiplier),
    0,
  );
  const clearHours = stormClearHours(totalClockHours, crews);

  let customersOut = 0;
  let hoursOut = 0;
  for (let i = 0; i < customers; i++) {
    const chanceOut = failureChance(scale, prepared.exposure[i]);
    const hoursIfOut = hoursWithoutPower(repairClockHours(prepared.repairHours[i], multiplier), clearHours);
    expectedHours[i] = expectedHoursWithoutPower(chanceOut, hoursIfOut);
    customersOut += chanceOut;
    hoursOut += chanceOut * hoursIfOut;
  }

  return {
    severity,
    scale,
    expectedHours,
    brokenPoles: target,
    customersOut,
    typicalHours: customersOut ? hoursOut / customersOut : 0,
    stormClearHours: clearHours,
  };
}
