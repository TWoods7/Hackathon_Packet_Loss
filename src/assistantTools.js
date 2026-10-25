// Tool handlers for the Outage Assistant (definitions: server/prompt.js).
// Claude asks for a tool, chatbot.js runs it here against the live map state,
// and the result goes back to Claude. Results are filtered for privacy: no
// premise IDs, coordinates, device IDs, or life-support flags ever leave here.
import { stormForecast } from "./outages.js";
import { CREWS, failureChance, repairClockHours, hoursWithoutPower, expectedRepairsOnPath } from "./restorationModel.js";

// Filled in by map.js once the map and data have loaded.
let mapApi = null;
let labor = null;
let medianExposure = null;

// Called by map.js when it is ready.
export function registerMapApi(api) {
  mapApi = api;
}

const NOTE = "Simulated from historical damage data. This is a model estimate, not an official restoration time.";

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
  return { level: "medium", reason: "Based on one past storm's damage pattern; real storms vary." };
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

// Customer counts are rounded so a small group can't be singled out.
function roughCount(n) {
  return n < 50 ? "fewer than 50" : `about ${(Math.round(n / 50) * 50).toLocaleString()}`;
}

// Where a repair sits, in plain words (no device IDs). onYourLine: whether it
// is between this home and the substation or on another branch of the outage.
function repairPlace(device, onYourLine) {
  const type = mapApi.grid.devices[device].type;
  if (type === "Circuit breaker") return "the main line leaving the substation";
  if (type === "Transformer") return onYourLine ? "the transformer that serves your street" : "a transformer on a nearby street";
  return onYourLine ? "a protective device on your line" : "a protective device on a nearby branch";
}

// Today's outage, step by step: the repairs on this home's line in the order a
// crew restores them (restorationOrder in restorationModel.js), and which step
// brings this home back.
function outageSteps(customer) {
  const zone = mapApi.zoneByCustomer.get(customer.index);
  const yourStep = mapApi.stepOfCustomer[customer.index];
  const chain = mapApi.grid.customerChains[customer.index];
  const steps = zone.steps.map((step, i) => ({
    step: i + 1,
    repair: `${repairPlace(step.device, chain.includes(step.device))} (${mapApi.damageSummary(step.damages)})`,
    on_your_line: chain.includes(step.device),
    customers_back_after_this_step: roughCount(step.customersRestored),
    hours_from_start: round1(step.doneAfterHours),
  }));
  const ownRepairs = steps.filter((s) => s.on_your_line);
  return {
    steps,
    your_step: yourStep + 1,
    total_steps: steps.length,
    repairs_on_your_line: ownRepairs.length,
    // Hours if a crew went straight to this home's repairs and skipped the rest.
    own_line_hours: round1(zone.steps.filter((s) => chain.includes(s.device)).reduce((sum, s) => sum + s.hours, 0)),
    hours_until_your_step: round1(zone.steps[yourStep].doneAfterHours),
  };
}

// Today's simulated outage status, in plain words.
function currentStatus(customer) {
  const chain = mapApi.grid.customerChains[customer.index];
  if (!chain.length) return { power: "unknown", detail: "No network data for this location." };
  const zone = mapApi.zoneByCustomer.get(customer.index);
  if (!zone) return { power: "on", detail: "No reported damage on the lines feeding this location." };
  const { your_step, total_steps, repairs_on_your_line } = outageSteps(customer);
  return {
    power: "off",
    cause: `Damaged equipment upstream: ${mapApi.damageSummary(zone.damages)}`,
    protective_device_tripped: mapApi.grid.devices[zone.device].type.toLowerCase(),
    customers_in_outage: roughCount(zone.customers.length),
    repair_work_hours: Math.round(zone.crewHours),
    restoration_step: `step ${your_step} of ${total_steps}`,
    repairs_on_your_line,
  };
}

// Plain-language place in the storm repair queue.
function queuePlace(share) {
  if (share < 0.33) return "near the front";
  if (share < 0.66) return "around the middle";
  return "toward the back";
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
    return { ...stormSummary(forecast), note: "The map's storm slider and heatmap now show this storm." };
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

    // Repair work on this home's own line, plus the access adder if crews can't reach it easily.
    const directHours = mapApi.forecastInputs.repairHours[customer.index] +
      (access_issue ? adders.restrictedAccess.hours : 0);
    const ownRepair = repairClockHours(directHours, multiplier);

    if (severity === 0) {
      const zone = mapApi.zoneByCustomer.get(customer.index);
      if (!zone) return { note: "No storm (severity 0%) and no current outage here, so there is nothing to restore." };
      // Today's outage: one crew restores it step by step, upstream repairs first.
      const plan = outageSteps(customer);
      const accessHours = access_issue ? repairClockHours(adders.restrictedAccess.hours, multiplier) * plan.repairs_on_your_line : 0;
      const typical = plan.hours_until_your_step + accessHours;
      return {
        scenario: "current outage",
        // Low: crews go straight to this home's repairs. High: double the typical for surprises.
        low_hours: round1(plan.own_line_hours + accessHours),
        typical_hours: round1(typical),
        high_hours: round1(typical * 2),
        restoration_steps: plan.steps,
        your_step: `step ${plan.your_step} of ${plan.total_steps}`,
        confidence: confidence.level,
        factors: [
          plan.repairs_on_your_line > 1
            ? `${plan.repairs_on_your_line} repairs are needed between this home and the substation. Crews fix the one closer to the substation first, because nothing past it can come back until it's done.`
            : "One repair is needed on this home's line.",
          plan.your_step > 1
            ? `Crews do the repairs that bring back the most customers first, so this home's power returns at step ${plan.your_step} of ${plan.total_steps}.`
            : "This home's repair is the first step, because it brings back the most customers.",
          access_issue
            ? `Access problems add about ${adders.restrictedAccess.hours} hours of work per repair.`
            : "Assumes crews can reach the damage without trouble.",
        ],
        could_change_if: "crews find more damage, more crews are sent, or the road to the damage is blocked",
        note: NOTE,
      };
    }

    const forecast = stormForecast(mapApi.grid, mapApi.forecastInputs, severity, crewCount);
    const clear = forecast.stormClearHours;
    const exposure = mapApi.forecastInputs.exposure[customer.index];
    const share = mapApi.forecastInputs.queueShare[customer.index];
    const lastDevice = mapApi.forecastInputs.lastRepairDevice[customer.index];
    const repairsOnPath = expectedRepairsOnPath(forecast.scale, exposure);
    return {
      scenario: `storm at ${Math.round(severity * 100)}% severity`,
      crews: crewCount,
      // Low: a crew reaches this repair first. High: it's the last repair of the storm.
      low_hours: round1(ownRepair),
      typical_hours: round1(hoursWithoutPower(ownRepair, clear, share)),
      high_hours: round1(ownRepair + clear),
      expected_repairs_on_your_line: round1(repairsOnPath),
      place_in_repair_queue: queuePlace(share),
      confidence: confidence.level,
      confidence_reason: confidence.reason,
      factors: [
        `Repair work on this home's line: about ${round1(ownRepair)} hours for one crew, including travel and setup.`,
        `Storm-wide backlog: ${crewCount} crews need about ${round1(clear)} hours to clear every expected repair.`,
        lastDevice >= 0
          ? `Crews fix repairs that bring back the most customers first. The last repair this home would need restores ${roughCount(mapApi.grid.devices[lastDevice].customers)} customers, so it is ${queuePlace(share)} of the queue.`
          : "No storm history on this line, so we assume the middle of the repair queue.",
        repairsOnPath >= 1.5
          ? `If the power goes out, about ${Math.round(repairsOnPath)} repairs are likely needed between this home and the substation; the ones closer to the substation are fixed first.`
          : "If the power goes out, most likely one repair is needed on this home's line.",
        access_issue
          ? `Access problems add about ${adders.restrictedAccess.hours} hours of work per repair.`
          : "Assumes crews can reach the damage without trouble.",
      ],
      could_change_if: "more or fewer crews, damage turns out worse than forecast, blocked roads, or upstream lines that must be fixed first",
      note: NOTE,
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
    if (mapApi.zoneByCustomer.has(customer.index)) reasons.push("This location is inside a current outage.");
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
