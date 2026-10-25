// Combine a storm forecast and sampled damage into one scenario result.
// The map and chatbot can consume this result during the integration step.

// Import the existing forecast and outage calculations.
import {
  stormForecast,
  trippedDevices,
  computeOutages,
} from "./outages.js";

// Import the reproducible damage sampler.
import { simulateStormDamage } from "./stormSimulation.js";

// Reuse the existing conversion from direct labor to total repair work.
import { crewHours } from "./restorationModel.js";

// Build one possible storm outcome.
//
// grid: the unpacked grid returned by loadGrid().
// prepared: the result of prepareForecast(grid).
// severity: a fraction from 0 to 1, such as 0.5 for 50%.
// seed: identifies the repeatable damage scenario.
export function buildStormScenario(
  grid,
  prepared,
  severity,
  seed = 2026,
) {
  // Reject percentages such as 50, which should instead be supplied as 0.5.
  if (
    !Number.isFinite(severity) ||
    severity < 0 ||
    severity > 1
  ) {
    throw new RangeError(
      "Severity must be between 0 and 1; use 0.5 for 50%.",
    );
  }

  // Calculate the expected forecast and its calibrated storm strength.
  const forecast = stormForecast(grid, prepared, severity);

  // Generate one damage outcome using that same storm strength.
  const damages = simulateStormDamage(
    grid,
    forecast.scale,
    seed,
  );

  // Sum direct labor for every repair, including multiple repairs
  // that happen to affect the same protective device.
  let directLaborHours = 0;

  for (const damage of damages) {
    // Missing labor values must not silently become zero-hour repairs.
    if (
      !Number.isFinite(damage.directHours) ||
      damage.directHours < 0
    ) {
      throw new Error(
        `Missing or invalid repair hours for ${damage.id}.`,
      );
    }

    directLaborHours += damage.directHours;
  }

  // Deduplicate the devices affected by the generated damage.
  const tripped = trippedDevices(damages);

  // Trace those devices through customer chains to create outage groups.
  const { noPower, zones } = computeOutages(
    grid,
    tripped,
    damages,
  );

  // Build a lookup for finding a customer's outage group quickly.
  const zoneByCustomer = new Map();

  for (const zone of zones) {
    // Each customer index refers to its position in customers.json.
    for (const customer of zone.customers) {
      zoneByCustomer.set(customer, zone);
    }
  }

  // Count customers marked without power in this sampled outcome.
  const customersOut = noPower.reduce(
    (sum, value) => sum + value,
    0,
  );

  // Include the existing travel/setup multiplier in the work total.
  // This measures repair effort, not elapsed restoration time.
  const repairWorkHours = crewHours(
    directLaborHours,
    grid.meta.indirectLaborMultiplier,
  );

  // Keep expected forecast values and sampled results together,
  // while preserving their different meanings.
  return {
    mode: "storm-simulation",
    severity,
    seed,
    forecast,
    damages,
    tripped,
    noPower,
    zones,
    zoneByCustomer,

    // These counts describe this particular sampled outcome.
    summary: {
      damages: damages.length,
      trippedDevices: tripped.size,
      customersOut,
      zones: zones.length,
      repairWorkHours,
    },
  };
}