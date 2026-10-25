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
  restorationOrder,
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
  const stepOfCustomer = new Int32Array(grid.customerChains.length).fill(-1);
  const zones = [...zonesByDevice.values()].map((zone) => ({
    ...zone,
    crewHours: crewHours(zone.damages.reduce((sum, d) => sum + (d.directHours ?? 0), 0), multiplier),
    steps: restorationSteps(grid, zone, multiplier, stepOfCustomer),
  }));
  zones.sort((a, b) => b.customers.length - a.customers.length);

  return { noPower, zones, stepOfCustomer };
}

// Split one outage into restoration steps: one per damaged device, in the order
// restorationOrder picks. Each step lists the customers it brings back (those
// whose most downstream damaged device it is). Fills stepOfCustomer.
function restorationSteps(grid, zone, multiplier, stepOfCustomer) {
  const jobs = new Map();
  for (const damage of zone.damages) {
    if (!jobs.has(damage.device)) {
      jobs.set(damage.device, {
        id: damage.device, damages: [], laborHours: 0, served: 0, restores: [], after: new Set(),
        priority: grid.devices[damage.device].priority ?? 0,
      });
    }
    const job = jobs.get(damage.device);
    job.damages.push(damage);
    job.laborHours += damage.directHours ?? 0;
  }

  for (const customer of zone.customers) {
    // Damaged devices on this customer's line, transformer first, substation last.
    const onPath = grid.customerChains[customer].filter((device) => jobs.has(device));
    onPath.forEach((device, k) => {
      const job = jobs.get(device);
      job.served++;
      for (const upstream of onPath.slice(k + 1)) job.after.add(upstream);
    });
    jobs.get(onPath[0]).restores.push(customer);
  }

  const order = restorationOrder([...jobs.values()].map((job) => ({ ...job, hours: repairClockHours(job.laborHours, multiplier) })));
  return order.map((job, step) => {
    for (const customer of job.restores) stepOfCustomer[customer] = step;
    return {
      device: job.id,
      damages: job.damages,
      hours: job.hours,
      workDoneHours: job.workDoneHours,
      doneAfterHours: job.doneAfterHours,
      customersRestored: job.restores.length,
      priority: job.priority > 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Storm forecast: chance of losing power and expected hours without power.
// The formulas themselves live in restorationModel.js.
// ---------------------------------------------------------------------------

// Candidate weights are a circuit's historical damage rate plus this floor
// (half for service poles; see build-outage-grid.js). A weight at the floor
// means the circuit had no recorded storm damage, so its risk is a baseline.
const BASELINE_WEIGHTS = [0.0005, 0.00025];
const isBaseline = (weight) => BASELINE_WEIGHTS.some((floor) => Math.abs(weight - floor) < 1e-7);

// Precompute per-customer totals once; the slider then only rescales them.
export function prepareForecast(grid) {
  // Per device: summed failure weight of the poles behind it, and weighted repair hours.
  const deviceWeight = new Float64Array(grid.devices.length);
  const deviceWeightedHours = new Float64Array(grid.devices.length);
  const deviceHistory = new Uint8Array(grid.devices.length);
  for (const [, , device, weight, hours] of grid.candidates) {
    deviceWeight[device] += weight;
    deviceWeightedHours[device] += weight * hours;
    if (!isBaseline(weight)) deviceHistory[device] = 1;
  }

  // Storm queue: crews fix repairs that restore priority locations first, then
  // those that restore the most customers (the same rule as restorationOrder).
  // A device's queue share is how far through the storm's repair work crews
  // are, on average, when they reach it.
  const isPriority = (d) => (grid.devices[d].priority ?? 0) > 0;
  const atRisk = [...deviceWeight.keys()].filter((d) => deviceWeight[d] > 0);
  atRisk.sort((a, b) => isPriority(b) - isPriority(a) || grid.devices[b].customers - grid.devices[a].customers);
  const totalWork = atRisk.reduce((sum, d) => sum + deviceWeightedHours[d], 0);
  const deviceQueueShare = new Float64Array(grid.devices.length);
  let workBefore = 0;
  for (const d of atRisk) {
    deviceQueueShare[d] = (workBefore + deviceWeightedHours[d] / 2) / (totalWork || 1);
    workBefore += deviceWeightedHours[d];
  }

  // Per customer: every pole that can cut its power is behind some device in its chain.
  const customers = grid.customerChains.length;
  const exposure = new Float64Array(customers);
  const repairHours = new Float64Array(customers);
  // The most downstream device on the line that can fail (-1 if none), and its queue share.
  const lastRepairDevice = new Int32Array(customers).fill(-1);
  const queueShare = new Float64Array(customers).fill(0.5);
  // 1 if the lines feeding this customer have recorded storm damage.
  const hasHistory = new Uint8Array(customers);
  grid.customerChains.forEach((chain, i) => {
    hasHistory[i] = chain.some((device) => deviceHistory[device]) ? 1 : 0;
    let weight = 0;
    let weightedHours = 0;
    for (const device of chain) {
      weight += deviceWeight[device];
      weightedHours += deviceWeightedHours[device];
    }
    exposure[i] = weight;
    repairHours[i] = weight ? weightedHours / weight : 0;
    // Chains run transformer -> substation, so the first at-risk device is the most downstream.
    const last = chain.find((device) => deviceWeight[device] > 0);
    if (last !== undefined) {
      lastRepairDevice[i] = last;
      queueShare[i] = deviceQueueShare[last];
    }
  });

  return { exposure, repairHours, lastRepairDevice, queueShare, hasHistory };
}

// Forecast outages for a storm severity from 0 (calm) to 1 (the worst storm in the data).
// crews: optional repair-crew count; defaults to CREWS in restorationModel.js.
// accessLaborHours: extra labor per repair when crews can't reach damage easily
// (blocked roads); the map's checkbox and the chatbot set it.
export function stormForecast(grid, prepared, severity, crews, accessLaborHours = 0) {
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
    (sum, row) => sum + failureChance(scale, row[3]) * repairClockHours(row[4] + accessLaborHours, multiplier),
    0,
  );
  const clearHours = stormClearHours(totalClockHours, crews);

  let customersOut = 0;
  let hoursOut = 0;
  for (let i = 0; i < customers; i++) {
    const chanceOut = failureChance(scale, prepared.exposure[i]);
    const hoursIfOut = hoursWithoutPower(
      repairClockHours(prepared.repairHours[i] + accessLaborHours, multiplier),
      clearHours,
      prepared.queueShare[i],
    );
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
