// Generate reproducible simulated storm damage.
// This module uses the existing grid and does not modify its source data.

// Reuse the same failure formula as the storm forecast.
import { failureChance } from "./restorationModel.js";

// Create a repeatable sequence of numbers between 0 and 1.
// Reusing a seed starts the sequence from the same point.
function createSeededRandom(seed) {
  // Store the generator's current state as an unsigned 32-bit integer.
  let state = seed >>> 0;

  return function nextRandom() {
    // Advance the state before generating the next number.
    state = (state + 0x6d2b79f5) >>> 0;

    // Mix the bits so consecutive candidates receive different values.
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    // Convert the result to a number from 0 inclusive to 1 exclusive.
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Generate one possible damage outcome.
//
// grid: the unpacked object returned by loadGrid().
// scale: forecast.scale returned by stormForecast(), NOT the slider percentage.
// seed: a repeatable scenario number; keep it unchanged while moving the slider.
export function simulateStormDamage(grid, scale, seed = 2026) {
  // Require the arrays produced by the existing browser grid loader.
  if (
    !Array.isArray(grid?.candidates) ||
    !Array.isArray(grid?.devices)
  ) {
    throw new TypeError(
      "Use the unpacked grid returned by loadGrid().",
    );
  }

  // Reject invalid storm strengths before calculating probabilities.
  if (!Number.isFinite(scale) || scale < 0) {
    throw new RangeError(
      "Storm scale must be a finite, nonnegative number.",
    );
  }

  // Keep the seed within the generator's supported integer range.
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff
  ) {
    throw new RangeError(
      "Seed must be an integer from 0 through 4294967295.",
    );
  }

  // Restart the random sequence for this scenario calculation.
  const random = createSeededRandom(seed);

  // Collect new simulated records without changing historical damage.
  const damages = [];

  // Inspect every candidate in its original grid order.
  for (const [index, row] of grid.candidates.entries()) {
    // These positions match grid.json's candidates.fields array.
    const [lng, lat, device, weight, directHours] = row;

    // Reject invalid weights or references to nonexistent devices.
    if (
      !Number.isFinite(weight) ||
      weight < 0 ||
      !Number.isInteger(device) ||
      device < 0 ||
      device >= grid.devices.length
    ) {
      throw new Error(
        `Invalid failure candidate at row ${index}.`,
      );
    }

    // Always draw once per candidate, including candidates that survive.
    // This keeps each candidate's draw consistent across slider changes.
    const draw = random();

    // Calculate the chance that this candidate fails in this storm.
    const probability = failureChance(scale, weight);

    // A draw outside the failure probability means the candidate survives.
    if (draw >= probability) continue;

    // Preserve the candidate's location, device link, and repair effort.
    // The current candidate table does not distinguish poles from wires,
    // so use a general damage label instead of inventing an asset type.
    damages.push({
      id: `storm-${seed}-${index}`,
      candidateIndex: index,
      lng,
      lat,
      device,
      circuit: grid.devices[device].circuit ?? null,
      assetType: "Line damage",
      damageType: "Simulated storm damage",

      // A simulated event has no historical report date.
      reported: null,

      directHours,
      traceMethod: "simulation-candidate",
      simulated: true,
    });
  }

  // Return the generated repairs; several may affect the same device.
  return damages;
}