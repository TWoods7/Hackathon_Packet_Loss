// Tool handlers for the Outage Assistant (definitions: server/prompt.js).
// Claude asks for a tool, chatbot.js runs it here against the live map state,
// and the result goes back to Claude. Results are filtered for privacy: no
// premise IDs, coordinates, device IDs, or life-support flags ever leave here.
import { stormForecast } from "./outages.js";
// Reuse the shared failure, queue, and restoration-range formulas.
import {
  CREWS, CREW_SIZE, failureChance, repairClockHours, withLunchBreaks,
  expectedRepairsOnPath, restorationRange, sampledRestorationRange,
} from "./restorationModel.js";
import { stormLevel, levelSeverity, levelLineDamage } from "./stormLevels.js";

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

// Report missing map coverage without using a distant customer's simulation.
function notCovered() {
  return {
    error: "This area is not covered.",
    covered: false,
    confidence: "low",
    reliable_match: false,
    has_network_data: false,
    note: "No location-specific simulation result is available here. Use the utility's official outage map or contact the utility.",
  };
}

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
  if (selected.covered === false) return notCovered();
  return selected;
}

// The storm level a tool asked for (an id from stormLevels.js), or the slider's.
function levelFrom(id) {
  if (id == null) return mapApi.getStormLevel();
  const level = stormLevel(id);
  if (!level) throw new Error(`Unknown storm level: ${id}`);
  return level;
}

// Forecast severity (0-1) for a level.
function severityOf(level) {
  return levelSeverity(level, mapApi.grid.meta.worstStorm);
}

// How a storm level is described to the customer: a name and a real storm it's like.
function describeStorm(level) {
  return {
    storm_level: level.name,
    like: level.like,
    expected_broken_poles_and_wires: levelLineDamage(level, mapApi.grid.meta.worstStorm),
  };
}

// How much to trust predictions for this location at a storm level, and why.
// Low: no usable network match. High: a close match, recorded storm damage on
// these lines, and a storm level that matches a real storm in the records.
// Medium: usable, but missing one or more of those.
function confidenceFor(customer, distance, level = mapApi.getStormLevel()) {
  const chain = mapApi.grid.customerChains[customer.index];
  if (!chain.length) return { level: "low", reason: "No network data links this location to the grid." };
  if (distance > MAX_MATCH_METERS) {
    return { level: "low", reason: "The address is far from any service point we know, so the match may be wrong." };
  }
  if (!mapApi.forecastInputs.exposure[customer.index]) {
    return { level: "low", reason: "No storm damage history for the lines feeding this location." };
  }

  const gaps = [];
  if (distance > CLOSE_MATCH_METERS) gaps.push("the address matched a nearby service point, not an exact one");
  if (!mapApi.forecastInputs.hasHistory[customer.index]) {
    gaps.push("the lines feeding this location have no recorded storm damage, so their risk uses an area-wide baseline");
  }
  if (!level.observed) gaps.push(`a ${level.name.toLowerCase()} falls between the storms in the records, so it's estimated from them`);
  if (!gaps.length) {
    return {
      level: "high",
      reason: "Close address match, recorded storm damage on these lines, and a storm level that matches a real storm in the records. Real storms still vary.",
    };
  }
  const reason = gaps.join("; ");
  return { level: "medium", reason: reason[0].toUpperCase() + reason.slice(1) + "." };
}

// The map's crew count and blocked-roads setting, which tools use by default.
function mapConditions() {
  return mapApi.getRepairConditions?.() ?? { crews: CREWS, roadsBlocked: false };
}

// Whether a device's repair also restores a priority location (hospital, station).
function servesPriority(device) {
  return device >= 0 && (mapApi.grid.devices[device].priority ?? 0) > 0;
}

const PRIORITY_FACTOR = "also restores a priority location (such as a hospital or fire station), so crews do it before other repairs";

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

// Active sampled outage, step by step: the repairs on this home's line in the order a
// crew restores them (restorationOrder in restorationModel.js), and which step
// brings this home back.
// accessClockHours: extra time per repair for blocked roads, added for every
// repair the crew finishes up to each step (the same rule as the map panel).
function outageSteps(customer, accessClockHours = 0) {
  const zone = mapApi.zoneByCustomer.get(customer.index);
  const yourStep = mapApi.stepOfCustomer?.[customer.index];

  // Reject stale or missing step data rather than guessing a duration.
  if (!zone || !Number.isInteger(yourStep) || yourStep < 0 || yourStep >= zone.steps.length) {
    throw new Error("Restoration-step information is unavailable for this scenario.");
  }
  const chain = mapApi.grid.customerChains[customer.index];
  let repairsSoFar = 0;
  const doneHours = zone.steps.map((step) => {
    repairsSoFar += step.damages.length;
    // Same rule as the map panel: lunch breaks on the continuous work so far.
    return withLunchBreaks(step.workDoneHours + accessClockHours * repairsSoFar);
  });
  const steps = zone.steps.map((step, i) => ({
    step: i + 1,
    repair: `${repairPlace(step.device, chain.includes(step.device))} (${mapApi.damageSummary(step.damages)})`,
    on_your_line: chain.includes(step.device),
    restores_priority_location: Boolean(step.priority),
    customers_back_after_this_step: roughCount(step.customersRestored),
    hours_from_start: round1(doneHours[i]),
  }));
  const ownSteps = zone.steps.filter((s) => chain.includes(s.device));
  return {
    steps,
    your_step: yourStep + 1,
    total_steps: steps.length,
    repairs_on_your_line: ownSteps.length,
    your_repair_restores_priority_location: Boolean(zone.steps[yourStep].priority),
    // Hours if a crew went straight to this home's repairs and skipped the rest.
    own_line_hours: ownSteps.reduce((sum, s) => sum + s.hours + accessClockHours * s.damages.length, 0),
    hours_until_your_step: doneHours[yourStep],
  };
}

// Read the same sampled outage state currently displayed on the map.
function currentStatus(customer) {
  const chain = mapApi.grid.customerChains[customer.index];
  if (!chain.length) return { power: "unknown", scenario: "simulated storm", detail: "No network data for this location." };
  const zone = mapApi.zoneByCustomer.get(customer.index);
  if (!zone) return { power: "on", scenario: "simulated storm", detail: "No outage was generated here in the displayed scenario. Other possible outcomes may differ." };

  // Expose the restoration step without returning internal device identities.
  const plan = outageSteps(customer);
  return {
    power: "off",
    scenario: "simulated storm",
    cause: `Damaged equipment upstream: ${mapApi.damageSummary(zone.damages)}`,
    protective_device_tripped: mapApi.grid.devices[zone.device].type.toLowerCase(),
    customers_in_outage: roughCount(zone.customers.length),
    repair_work_hours: Math.round(zone.crewHours),
    restoration_step: `step ${plan.your_step} of ${plan.total_steps}`,
    repairs_on_your_line: plan.repairs_on_your_line,
  };
}
// Plain-language place in the storm repair queue.
function queuePlace(share) {
  if (share < 0.33) return "near the front";
  if (share < 0.66) return "around the middle";
  return "toward the back";
}

// Area-wide summary of a storm forecast.
function stormSummary(forecast, level) {
  if (forecast.severity === 0) return { ...describeStorm(level), summary: "Calm weather: no storm damage expected." };
  return {
    ...describeStorm(level),
    customers_likely_out: Math.round(forecast.customersOut / 100) * 100,
    typical_hours_without_power: round1(forecast.typicalHours),
    hours_for_all_crews_to_finish: round1(forecast.stormClearHours),
    repair_conditions: repairConditionsSummary(),
  };
}

// The storm panel's crews and roads, as tools report them.
function repairConditionsSummary() {
  const { crews, roadsBlocked } = mapConditions();
  return { crews, roads_blocked: roadsBlocked };
}

// What a utility agent would see when the customer asks for a person: the
// customer's own matched address and the model's results, no internal IDs.
// safetyFlags: safety topics the chat detected, e.g. "downed line reported".
export async function handoffSummary({ declared_needs, safety_flags }) {
  const needs = declared_needs ?? [];
  const summary = {
    reasons: [
      ...safety_flags,
      ...(needs.length ? [`declared need: ${needs.join(", ").replaceAll("_", " ")}`] : []),
    ],
    declared_needs: needs,
  };
  const selected = mapApi && mapApi.getSelection();
  if (!selected) return { ...summary, location: "not provided yet" };
  if (selected.covered === false) {
    return { ...summary, ...notCovered(), location: selected.formattedAddress ?? "outside map coverage" };
  }

  const status = currentStatus(selected.customer);
  const restoration = await handlers.estimate_restoration({ storm_level: null, crews: null, access_issue: null });
  return {
    ...summary,
    location: selected.formattedAddress,
    storm: mapApi.getStormLevel().name,
    simulated_power: status.power,
    restoration_step: status.restoration_step ?? null,
    restoration_range_hours: restoration.low_hours != null
      ? `${restoration.low_hours} to ${restoration.high_hours}, most likely ${restoration.typical_hours}`
      : null,
    confidence: confidenceFor(selected.customer, selected.distance).level,
  };
}

// Planning range from the storm's expected work, for any severity. Used when
// the displayed sample has no outage at this location, or for a what-if.
function forecastRange(customer, severity, crewCount, accessLaborHours = 0) {
  const multiplier = mapApi.grid.meta.indirectLaborMultiplier;
  const ownRepair = repairClockHours(mapApi.forecastInputs.repairHours[customer.index] + accessLaborHours, multiplier);
  const forecast = stormForecast(mapApi.grid, mapApi.forecastInputs, severity, crewCount, accessLaborHours);
  const range = restorationRange(ownRepair, forecast.stormClearHours, mapApi.forecastInputs.queueShare[customer.index]);
  return { ...range, forecast };
}

// Alert eligibility under the documented rules (alert_rules in server/prompt.js).
function alertEligibility(customer, needs) {
  const severity = mapApi.getSeverity();
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
  };
}

// Hours as they'd read in a text message.
function smsHours(hours) {
  if (hours < 1) return "under 1 hr";
  if (hours < 36) return `${Math.round(hours)} hrs`;
  return `${Math.round(hours / 24 * 2) / 2} days`;
}

// "3 hrs to 1.5 days, most likely about 14 hrs"
function smsRange({ lowHours, typicalHours, highHours }) {
  return `${smsHours(lowHours)} to ${smsHours(highHours)}, most likely about ${smsHours(typicalHours)}`;
}

// Text messages are capped at one SMS segment group; every template fits.
const SMS_LIMIT = 320;
const SAFETY = "Stay 35 ft from downed lines and call 911 if you see one.";

// The four customer notifications for the selected location, built from the
// same model numbers as the other tools. Exported for the chat's alert button.
export async function draftNotifications({ declared_needs }) {
  const selected = selection();
  if (selected.error) return selected;
  const { customer, distance } = selected;
  const needs = declared_needs ?? [];
  const severity = mapApi.getSeverity();
  const eligibility = alertEligibility(customer, needs);
  const confidence = confidenceFor(customer, distance);
  const reliable = confidence.level !== "low";
  // Use the storm panel's crews and roads, like the other tools.
  const conditions = mapConditions();
  const accessLaborHours = conditions.roadsBlocked ? (await loadLabor()).adders.restrictedAccess.hours : 0;

  // Current estimate: the displayed sample's outage if there is one here,
  // otherwise the storm forecast. None when calm or the match isn't reliable.
  let estimate = null;
  let estimateSource = "none";
  if (reliable) {
    const sampled = await handlers.estimate_restoration({ storm_level: null, crews: null, access_issue: null });
    if (sampled.low_hours != null) {
      estimate = { lowHours: sampled.low_hours, typicalHours: sampled.typical_hours, highHours: sampled.high_hours };
      estimateSource = "displayed sampled outage";
    } else if (severity > 0) {
      estimate = forecastRange(customer, severity, conditions.crews, accessLaborHours);
      estimateSource = "storm forecast";
    }
  }

  // Example of a changed estimate: half the crews are sent to harder-hit areas.
  const fewerCrews = Math.round(conditions.crews / 2);
  let updated = null;
  if (estimate) {
    const sampled = estimateSource === "displayed sampled outage"
      ? await handlers.estimate_restoration({ storm_level: null, crews: fewerCrews, access_issue: null })
      : null;
    updated = sampled?.low_hours != null
      ? { lowHours: sampled.low_hours, typicalHours: sampled.typical_hours, highHours: sampled.high_hours }
      : forecastRange(customer, severity, fewerCrews, accessLaborHours);
  }

  const band = severity > 0 && reliable
    ? riskBand(failureChance(stormForecast(mapApi.grid, mapApi.forecastInputs, severity).scale, mapApi.forecastInputs.exposure[customer.index]))
    : null;
  const priorityLine = eligibility.priority_escalation ? " You're on our priority list; we'll call if it lasts over 4 hrs." : "";

  const messages = [
    {
      id: "pre_storm",
      title: "Before the storm",
      send_when: "24 hours and 6 hours before the storm arrives",
      text: `Storm alert (simulated): A storm is heading for your area.${band ? ` Outage risk at your address: ${band}.` : ""} ` +
        `Charge phones and keep flashlights and water ready. ${SAFETY} Report outages on the official outage map.`,
    },
    {
      id: "outage_confirmed",
      title: "Outage confirmed",
      send_when: "When an outage is confirmed",
      text: "Outage (simulated): Power is out in your area from storm damage on your line. " +
        (estimate ? `Estimated restoration: ${smsRange(estimate)}.` : "Crews are assessing the damage; we'll text an estimate soon.") +
        `${priorityLine} ${SAFETY} Never run a generator indoors.`,
    },
    {
      id: "estimate_updated",
      title: "Estimate updated",
      send_when: "When the estimate changes by more than 2 hours",
      text: updated
        ? `Update (simulated): Your restoration estimate is now ${smsRange(updated)}, because crews were sent to harder-hit areas. ${SAFETY}`
        : `Update (simulated): Your restoration estimate has changed. We'll text the new time range as soon as crews assess the damage. ${SAFETY}`,
    },
    {
      id: "restored",
      title: "Power restored",
      send_when: "When power is restored",
      text: "Power restored (simulated): Power is back on in your area. If yours is still out, report it on the official outage map; " +
        "your home may have a separate problem. Check food that was in the fridge.",
    },
  ].map((message) => ({ ...message, channels: eligibility.channels, characters: message.text.length }));

  const tooLong = messages.find((m) => m.characters > SMS_LIMIT);
  if (tooLong) throw new Error(`The ${tooLong.title} message is over ${SMS_LIMIT} characters.`);

  return {
    ...eligibility,
    ...describeStorm(mapApi.getStormLevel()),
    estimate_source: estimateSource,
    estimate_update_example: updated ? `same storm with ${fewerCrews} crews instead of ${conditions.crews}` : null,
    confidence: confidence.level,
    messages,
    note: (reliable
      ? ""
      : "This location can't be matched reliably, so the messages leave out time estimates. ") +
      "Example messages from a simulation, not real notifications. Rules are the team's documented challenge assumptions, not utility policy.",
  };
}

const handlers = {
  async search_address({ address }) {
    if (!mapApi) return { error: "The map is still loading. Try again in a moment." };
    const result = await mapApi.searchAddress(address);
    if (result.covered === false) return notCovered();
    const { formattedAddress, customer, distance } = result;
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
      ...describeStorm(mapApi.getStormLevel()),
      is_calm: mapApi.getSeverity() === 0,
      repair_conditions: repairConditionsSummary(),
      confidence: confidenceFor(selected.customer, selected.distance).level,
      note: NOTE,
    };
  },

  async set_storm_level({ level }) {
    if (!mapApi) return { error: "The map is still loading. Try again in a moment." };
    const forecast = mapApi.setStormLevel(levelFrom(level).id);
    // Return safe area-wide counts, never asset identifiers or coordinates.
    const { summary } = mapApi.getScenario();
    return {
      ...stormSummary(forecast, mapApi.getStormLevel()),
      sampled_outcome: {
        damage_locations: summary.damages,
        customers_without_power: summary.customersOut,
        outage_areas: summary.zones,
      },
      note: "The slider, heatmap, damage markers, and outage areas now show this storm. " + NOTE,
    };
  },

  async get_outage_risk({ storm_level }) {
    const selected = selection();
    if (selected.error) return selected;
    const { customer, distance } = selected;
    const level = levelFrom(storm_level);
    const severity = severityOf(level);
    const confidence = confidenceFor(customer, distance, level);
    if (severity === 0) {
      return {
        ...describeStorm(level),
        risk_band: "Low",
        note: "Calm weather, so no storm outage is expected. Choose a storm level to forecast a storm.",
      };
    }

    const forecast = stormForecast(mapApi.grid, mapApi.forecastInputs, severity);
    const exposure = mapApi.forecastInputs.exposure[customer.index];
    const chance = failureChance(forecast.scale, exposure);
    const relative = exposure / (exposureMedian() || 1);
    return {
      ...describeStorm(level),
      risk_band: riskBand(chance),
      chance_of_outage: Math.round(chance * 100) / 100,
      confidence: confidence.level,
      confidence_reason: confidence.reason,
      factors: [
        `Storm strength: ${level.name.toLowerCase()}, like ${level.like} (about ${levelLineDamage(level, mapApi.grid.meta.worstStorm)} broken poles and wires across the area).`,
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

  async estimate_restoration({ storm_level, crews, access_issue }) {
    // Read the selected location and requested operational assumptions.
    const selected = selection();
    if (selected.error) return selected;
    const { customer, distance } = selected;
    const level = levelFrom(storm_level);
    const severity = severityOf(level);
    // Crews and access default to the map's storm panel settings.
    const conditions = mapConditions();
    const crewCount = crews == null ? conditions.crews : clamp(crews, 10, 200);
    const roadsBlocked = access_issue ?? conditions.roadsBlocked;
    const { adders } = await loadLabor();
    const multiplier = mapApi.grid.meta.indirectLaborMultiplier;
    const confidence = confidenceFor(customer, distance, level);

    // A distant or disconnected match cannot support a restoration prediction.
    if (!mapApi.grid.customerChains[customer.index].length || distance > MAX_MATCH_METERS) {
      return { confidence: "low", note: "A reliable network match is unavailable, so a restoration range cannot be calculated. " + NOTE };
    }

    // These inputs change repair duration without changing the failure sample.
    const accessLaborHours = roadsBlocked ? adders.restrictedAccess.hours : 0;
    const share = mapApi.forecastInputs.queueShare[customer.index];
    const active = mapApi.getScenario();

    // At the displayed storm level, use this sample's upstream-dependent steps.
    if (severity === active.severity) {
      const zone = mapApi.zoneByCustomer.get(customer.index);
      if (!zone) {
        return {
          scenario: "displayed sampled storm outcome",
          outage_simulated: false,
          note: "No outage was generated here in this sample, so there is no sampled restoration duration. Other possible outcomes may differ. " + NOTE,
        };
      }

      // Sum labor inputs, then let the shared model handle all time formulas.
      // Step times already include the access allowance, so it isn't added again.
      const plan = outageSteps(customer, repairClockHours(accessLaborHours, multiplier));
      const zoneLaborHours = zone.damages.reduce((sum, damage) => sum + damage.directHours + accessLaborHours, 0);
      const stormLaborHours = active.damages.reduce((sum, damage) => sum + damage.directHours + accessLaborHours, 0);
      const range = sampledRestorationRange({
        ownLineHours: plan.own_line_hours,
        stepHours: plan.hours_until_your_step,
        zoneLaborHours,
        stormLaborHours,
        repairsOnLine: plan.repairs_on_your_line,
        accessLaborHours: 0,
        multiplier,
        crews: crewCount,
        queueShare: share,
      });

      // Return only customer-friendly steps and aggregate work information.
      return {
        scenario: "displayed sampled storm outcome",
        outage_simulated: true,
        crews: crewCount,
        roads_blocked: roadsBlocked,
        low_hours: round1(range.lowHours),
        typical_hours: round1(range.typicalHours),
        high_hours: round1(range.highHours),
        restoration_steps: plan.steps,
        your_step: `step ${plan.your_step} of ${plan.total_steps}`,
        repairs_on_your_line: plan.repairs_on_your_line,
        place_in_repair_queue: queuePlace(share),
        confidence: confidence.level,
        confidence_reason: confidence.reason,
        factors: [
          `${plan.repairs_on_your_line} repairs are needed on this location's upstream path; dependent repairs wait for the repairs ahead of them.`,
          `This location is restored at step ${plan.your_step} of ${plan.total_steps} in the area's assumed single-crew schedule.`,
          `Step times start when the area's crew begins work; the duration range also allows for work elsewhere in the storm with ${crewCount} crews of ${CREW_SIZE}.`,
          "The area's own work is excluded from that outside backlog to avoid double counting it.",
          ...(plan.your_repair_restores_priority_location ? [`The repair that brings this location back ${PRIORITY_FACTOR}.`] : []),
          roadsBlocked ? "Includes extra time for every repair because roads are blocked." : "Assumes crews can reach the damage normally.",
        ],
        note: "Step times use one crew. The range adds queue assumptions; it is not a statistical confidence interval. " + NOTE,
      };
    }

    // A different storm level describes a hypothetical forecast without moving the map.
    if (severity === 0) {
      return { scenario: "hypothetical calm forecast", note: "No new storm damage is expected in calm weather. The displayed map scenario has not been changed. " + NOTE };
    }

    // Preserve the team's expected repair-count and queue-position explanation.
    const { forecast, ...range } = forecastRange(customer, severity, crewCount, accessLaborHours);
    const lastDevice = mapApi.forecastInputs.lastRepairDevice[customer.index];
    const exposure = mapApi.forecastInputs.exposure[customer.index];
    const repairsOnPath = expectedRepairsOnPath(forecast.scale, exposure);

    // Keep hypothetical results clearly separate from the displayed sample.
    return {
      scenario: `hypothetical forecast for a ${level.name.toLowerCase()}`,
      ...describeStorm(level),
      crews: crewCount,
      roads_blocked: roadsBlocked,
      low_hours: round1(range.lowHours),
      typical_hours: round1(range.typicalHours),
      high_hours: round1(range.highHours),
      expected_repairs_on_your_line: round1(repairsOnPath),
      place_in_repair_queue: queuePlace(share),
      confidence: confidence.level,
      confidence_reason: confidence.reason,
      factors: [
        "Uses expected work and repair-queue position, rather than the displayed sample's damage list.",
        servesPriority(lastDevice)
          ? `The last repair this line would need ${PRIORITY_FACTOR}, putting it ${queuePlace(share)} of the assumed queue.`
          : lastDevice >= 0
            ? `The last at-risk repair on this line serves ${roughCount(mapApi.grid.devices[lastDevice].customers)} customers, putting it ${queuePlace(share)} of the assumed queue.`
            : "Assumes the middle of the repair queue because no at-risk device is identified.",
        "Expected repairs on the line are an explanatory model estimate, not a list of confirmed damage.",
        roadsBlocked ? "Includes extra time for every repair because roads are blocked." : "Assumes crews can reach the damage normally.",
      ],
      note: "The displayed map scenario has not been changed. This is an assumption-based planning range. " + NOTE,
    };
  },

  async check_alert_eligibility({ declared_needs }) {
    const selected = selection();
    if (selected.error) return selected;
    return {
      ...alertEligibility(selected.customer, declared_needs ?? []),
      note: "Rules are the team's documented challenge assumptions, not utility policy.",
    };
  },

  draft_notifications: draftNotifications,
};

// Short status line shown in the chat while a tool runs.
export const TOOL_STATUS = {
  search_address: "Looking up your address…",
  get_current_status: "Checking current outages…",
  set_storm_level: "Updating the storm forecast on the map…",
  get_outage_risk: "Forecasting your outage risk…",
  estimate_restoration: "Estimating restoration time…",
  check_alert_eligibility: "Checking alert eligibility…",
  draft_notifications: "Drafting your alert messages…",
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
