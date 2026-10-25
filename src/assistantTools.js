// Tool handlers for the Outage Assistant (definitions: server/prompt.js).
// Claude asks for a tool, chatbot.js runs it here against the live map state,
// and the result goes back to Claude. Results are filtered for privacy: no
// premise IDs, coordinates, device IDs, or life-support flags ever leave here.
import { stormForecast } from "./outages.js";
import { CREWS, CREW_SIZE, failureChance, repairClockHours, stormClearHours, hoursWithoutPower } from "./restorationModel.js";

// Filled in by map.js once the map and data have loaded.
let mapApi = null;
let labor = null;
let medianExposure = null;

// Called by map.js when it is ready.
export function registerMapApi(api) {
  mapApi = api;
}

const NOTE = "The displayed outages are one sampled storm outcome; risk forecasts describe expected outcomes. All results are simulated, not confirmed utility outages or official restoration times.";

// Searched locations farther than this from any service point aren't trusted.
const MAX_MATCH_METERS = 500;
const CLOSE_MATCH_METERS = 150;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round1 = (value) => Math.round(value * 10) / 10;

// Labor adders (restricted access) come from the same workbook as everything else.
async function loadLabor() {
  if (!labor) labor = await (await fetch("/data/labor.json")).json();
  return labor;
}

// Median exposure across customers with network data, to say "above/below average".
function exposureMedian() {
  if (medianExposure === null) {
    const values = [...mapApi.forecastInputs.exposure].filter((v) => v > 0).sort((a, b) => a - b);
    medianExposure = values[Math.floor(values.length / 2)] ?? 0;
  }
  return medianExposure;
}

// The customer node matched to the last searched address, or an error result.
function selection() {
  if (!mapApi) return { error: "The map is still loading. Try again in a moment." };
  const selected = mapApi.getSelection();
  if (!selected) return { error: "No address searched yet. Ask the customer for their address and call search_address." };
  return selected;
}

// Severity 0-1 from a tool's percent argument, or the slider's current value.
function severityFrom(percent) {
  return percent == null ? mapApi.getSeverity() : clamp(percent, 0, 100) / 100;
}

// How much to trust predictions for this location, and why.
function confidenceFor(customer, distance) {
  const chain = mapApi.grid.customerChains[customer.index];
  if (!chain.length) return { level: "low", reason: "No network data links this location to the grid." };
  if (distance > MAX_MATCH_METERS) {
    return { level: "low", reason: "The address is far from any service point we know, so the match may be wrong." };
  }
  if (!mapApi.forecastInputs.exposure[customer.index]) {
    return { level: "low", reason: "No storm damage history for the lines feeding this location." };
  }
  if (distance > CLOSE_MATCH_METERS) {
    return { level: "medium", reason: "The address matched a nearby service point, not an exact one." };
  }
  return { level: "medium", reason: "Uses historical damage patterns and assumed storm strength; actual outcomes vary." };
}

// Plain-language risk band for a chance between 0 and 1.
function riskBand(chance) {
  if (chance < 0.15) return "Low";
  if (chance < 0.4) return "Moderate";
  if (chance < 0.7) return "High";
  return "Very high";
}

// Protective devices (fuses, reclosers, breakers) between this home and the substation.
function protectiveDevices(customer) {
  return mapApi.grid.customerChains[customer.index]
    .map((d) => mapApi.grid.devices[d].type)
    .filter((type) => type !== "Transformer").length;
}

// Read the same sampled outage state currently displayed on the map.
function currentStatus(customer) {
  const chain = mapApi.grid.customerChains[customer.index];
  if (!chain.length) return { power: "unknown", scenario: "simulated storm", detail: "No network data for this location." };
  const zone = mapApi.zoneByCustomer.get(customer.index);
  if (!zone) return { power: "on", scenario: "simulated storm", detail: "No outage was generated here in the displayed scenario. Other possible outcomes may differ." };
  return {
    power: "off",
    scenario: "simulated storm",
    cause: `Damaged equipment upstream: ${mapApi.damageSummary(zone.damages)}`,
    protective_device_tripped: mapApi.grid.devices[zone.device].type.toLowerCase(),
    customers_in_outage: zone.customers.length < 50 ? "fewer than 50" : `about ${Math.round(zone.customers.length / 50) * 50}`,
    repair_work_hours: Math.round(zone.crewHours),
  };
}

// Area-wide summary of a storm forecast.
function stormSummary(forecast) {
  if (forecast.severity === 0) return { severity_percent: 0, summary: "Calm weather: no storm damage expected." };
  return {
    severity_percent: Math.round(forecast.severity * 100),
    broken_poles_and_wires: Math.round(forecast.brokenPoles),
    customers_likely_out: Math.round(forecast.customersOut / 100) * 100,
    typical_hours_without_power: round1(forecast.typicalHours),
    hours_for_all_crews_to_finish: round1(forecast.stormClearHours),
  };
}

const handlers = {
  async search_address({ address }) {
    if (!mapApi) return { error: "The map is still loading. Try again in a moment." };
    const { formattedAddress, customer, distance } = await mapApi.searchAddress(address);
    const confidence = confidenceFor(customer, distance);
    return {
      matched_address: formattedAddress,
      distance_to_service_point_ft: Math.round(distance * 3.28084 / 10) * 10,
      reliable_match: distance <= MAX_MATCH_METERS,
      has_network_data: mapApi.grid.customerChains[customer.index].length > 0,
      current_status: currentStatus(customer),
      confidence: confidence.level,
      note: "The map now shows this address. " + NOTE,
    };
  },

  async get_current_status() {
    const selected = selection();
    if (selected.error) return selected;
    return {
      ...currentStatus(selected.customer),
      storm_severity_percent: Math.round(mapApi.getSeverity() * 100),
      confidence: confidenceFor(selected.customer, selected.distance).level,
      note: NOTE,
    };
  },

  async set_storm_severity({ percent }) {
    if (!mapApi) return { error: "The map is still loading. Try again in a moment." };
    const forecast = mapApi.setStormSeverity(Math.round(clamp(percent, 0, 100) / 5) * 5);
    // Return safe area-wide counts, never asset identifiers or coordinates.
    const { summary } = mapApi.getScenario();
    return {
      ...stormSummary(forecast),
      sampled_outcome: {
        damage_locations: summary.damages,
        customers_without_power: summary.customersOut,
        outage_areas: summary.zones,
      },
      note: "The slider, heatmap, damage markers, and outage areas now show this storm. " + NOTE,
    };
  },

  async get_outage_risk({ severity_percent }) {
    const selected = selection();
    if (selected.error) return selected;
    const { customer, distance } = selected;
    const severity = severityFrom(severity_percent);
    const confidence = confidenceFor(customer, distance);
    if (severity === 0) {
      return {
        severity_percent: 0,
        risk_band: "Low",
        note: "Storm severity is 0% (calm), so no storm outage is expected. Set a severity to forecast a storm.",
      };
    }

    const forecast = stormForecast(mapApi.grid, mapApi.forecastInputs, severity);
    const exposure = mapApi.forecastInputs.exposure[customer.index];
    const chance = failureChance(forecast.scale, exposure);
    const relative = exposure / (exposureMedian() || 1);
    return {
      severity_percent: Math.round(severity * 100),
      risk_band: riskBand(chance),
      chance_of_outage: Math.round(chance * 100) / 100,
      confidence: confidence.level,
      confidence_reason: confidence.reason,
      factors: [
        `Storm strength: ${Math.round(severity * 100)}% of the worst storm on record.`,
        `Power reaches this home through ${protectiveDevices(customer)} protective devices; more line upstream means more places a failure can cut power.`,
        relative > 1.2
          ? `Lines feeding this home were damaged about ${round1(relative)}x as often as the area's typical home in past storms.`
          : relative < 0.8
            ? "Lines feeding this home were damaged less often than average in past storms."
            : "Lines feeding this home had about average storm damage in the past.",
      ],
      could_change_if: "the storm's path or strength changes, trees near your lines, or repairs/upgrades since the data was collected",
      note: NOTE,
    };
  },

  async estimate_restoration({ severity_percent, crews, access_issue }) {
    const selected = selection();
    if (selected.error) return selected;
    const { customer, distance } = selected;
    const severity = severityFrom(severity_percent);
    const crewCount = crews == null ? CREWS : clamp(crews, 10, 200);
    const { adders } = await loadLabor();
    const multiplier = mapApi.grid.meta.indirectLaborMultiplier;
    const confidence = confidenceFor(customer, distance);

    // Do not estimate restoration for a location with no usable network match.
    if (!mapApi.grid.customerChains[customer.index].length || distance > MAX_MATCH_METERS) {
      return { confidence: "low", note: "A reliable network match is unavailable, so a restoration range cannot be calculated. " + NOTE };
    }

    // A staffing or access change affects repair time, not which assets failed.
    const accessHours = access_issue ? adders.restrictedAccess.hours : 0;
    const active = mapApi.getScenario();

    // At the displayed severity, estimate work from its actual sampled repairs.
    if (severity === active.severity) {
      const zone = mapApi.zoneByCustomer.get(customer.index);
      if (!zone) {
        return {
          scenario: "displayed sampled storm outcome",
          outage_simulated: false,
          note: "No outage was generated here in this sample, so there is no sampled restoration duration. Ask for outage risk to explore other possible outcomes. " + NOTE,
        };
      }

      // Aggregate repair labor, then reuse the existing restoration formulas.
      const zoneLabor = zone.damages.reduce((sum, damage) => sum + damage.directHours, 0);
      const allLabor = active.damages.reduce((sum, damage) => sum + damage.directHours, 0);
      const ownRepair = repairClockHours(zoneLabor + accessHours, multiplier);
      const clear = stormClearHours(repairClockHours(allLabor + accessHours, multiplier), crewCount);
      return {
        scenario: "displayed sampled storm outcome",
        outage_simulated: true,
        crews: crewCount,
        low_hours: round1(ownRepair),
        typical_hours: round1(hoursWithoutPower(ownRepair, clear)),
        high_hours: round1(ownRepair + clear),
        confidence: confidence.level,
        confidence_reason: confidence.reason,
        factors: [
          "Uses generated repairs assigned to this outage area and the sampled storm-wide repair backlog.",
          `Assumes one crew of ${CREW_SIZE} handles this area's repairs sequentially and ${crewCount} crews address the storm backlog.`,
          access_issue ? "Includes one declared restricted-access allowance for this area's work." : "Assumes normal repair access.",
        ],
        note: "This planning range uses simple queue assumptions, not a validated statistical confidence interval. " + NOTE,
      };
    }

    // A different requested severity is a hypothetical forecast, not a map change.
    if (severity === 0) {
      return { scenario: "hypothetical calm forecast", note: "No new storm damage is expected at 0%. The displayed map scenario has not been changed. " + NOTE };
    }

    // Preserve the existing expected-work model for hypothetical storm strengths.
    const ownRepair = repairClockHours(mapApi.forecastInputs.repairHours[customer.index] + accessHours, multiplier);
    const forecast = stormForecast(mapApi.grid, mapApi.forecastInputs, severity, crewCount);
    const clear = forecast.stormClearHours;
    return {
      scenario: `hypothetical forecast at ${Math.round(severity * 100)}% severity`,
      crews: crewCount,
      low_hours: round1(ownRepair),
      typical_hours: round1(hoursWithoutPower(ownRepair, clear)),
      high_hours: round1(ownRepair + clear),
      confidence: confidence.level,
      confidence_reason: confidence.reason,
      factors: [
        "Uses expected repair work and backlog, rather than the displayed sample's damage list.",
        `Assumes ${crewCount} crews of ${CREW_SIZE} and ${access_issue ? "one restricted-access allowance" : "normal access"}.`,
      ],
      note: "The displayed map scenario has not been changed. This is an assumption-based planning range. " + NOTE,
    };
  },

  async check_alert_eligibility({ declared_needs }) {
    const selected = selection();
    if (selected.error) return selected;
    const { customer } = selected;
    const severity = mapApi.getSeverity();
    const needs = declared_needs ?? [];
    const reasons = [];

    if (severity > 0) {
      const forecast = stormForecast(mapApi.grid, mapApi.forecastInputs, severity);
      const band = riskBand(failureChance(forecast.scale, mapApi.forecastInputs.exposure[customer.index]));
      if (band !== "Low") reasons.push(`Outage risk is ${band} for the current storm forecast.`);
    }
    if (mapApi.zoneByCustomer.has(customer.index)) reasons.push("An outage was generated for this location in the displayed storm scenario.");
    if (needs.length) reasons.push(`Customer declared: ${needs.join(", ").replaceAll("_", " ")}.`);

    const priority = needs.length > 0;
    return {
      eligible: reasons.length > 0,
      reasons: reasons.length ? reasons : ["Risk is Low and there is no current outage or declared need."],
      priority_escalation: priority,
      channels: priority ? ["SMS", "email", "phone call"] : ["SMS", "email"],
      timing: [
        "24 hours before the storm",
        "6 hours before the storm",
        "when an outage is confirmed",
        "when the estimate changes by more than 2 hours",
        "when power is restored",
      ],
      escalate_to_human_when: [
        ...(priority ? ["outage lasts more than 4 hours (declared need)"] : []),
        "a downed line is reported",
        "the model can't make a reliable prediction",
      ],
      note: "Rules are the team's documented challenge assumptions, not utility policy.",
    };
  },
};

// Short status line shown in the chat while a tool runs.
export const TOOL_STATUS = {
  search_address: "Looking up your address…",
  get_current_status: "Checking current outages…",
  set_storm_severity: "Updating the storm forecast on the map…",
  get_outage_risk: "Forecasting your outage risk…",
  estimate_restoration: "Estimating restoration time…",
  check_alert_eligibility: "Checking alert eligibility…",
};

// Run one tool_use block and return its tool_result block.
export async function runTool({ id, name, input }) {
  try {
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    const result = await handler(input ?? {});
    return { type: "tool_result", tool_use_id: id, content: JSON.stringify(result), is_error: Boolean(result.error) };
  } catch (err) {
    return { type: "tool_result", tool_use_id: id, content: JSON.stringify({ error: err.message }), is_error: true };
  }
}
