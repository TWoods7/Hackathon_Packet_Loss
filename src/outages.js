// Outage engine: decide which customers lose power when devices trip.
// Data comes from public/data/grid.json (npm run data:grid).

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

  // Crew-hours = direct labor x the workbook's indirect labor multiplier.
  const multiplier = grid.meta.indirectLaborMultiplier;
  const zones = [...zonesByDevice.values()].map((zone) => ({
    ...zone,
    crewHours: zone.damages.reduce((sum, d) => sum + (d.directHours ?? 0), 0) * multiplier,
  }));
  zones.sort((a, b) => b.customers.length - a.customers.length);

  return { noPower, zones };
}
