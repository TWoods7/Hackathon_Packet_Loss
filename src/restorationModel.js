// Restoration-time model: the ONE place every repair-time and outage-length
// number in the app comes from. Change a formula here and it changes everywhere:
//   - scripts/dataBuildScripts/build-outage-grid.js uses repairLaborHours
//     (re-run `npm run data:grid` after changing it, since results are stored in grid.json)
//   - src/outages.js uses the rest for today's outages (including restoration steps) and the storm forecast
//   - src/map.js shows CREWS / CREW_SIZE in the storm panel
// This file must stay plain JavaScript (no browser or Node APIs) so both can import it.

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Repair crews working a storm, and people per crew (workbook labor hours are per person).
// 60 crews of 4 restore the worst storm in about two days on average, matching the
// 1-2 day median repair time recorded for the Feb 2025 storm.
export const CREWS = 60;
export const CREW_SIZE = 4;

// ---------------------------------------------------------------------------
// 1. Labor hours for one repair, from public/data/labor.json
// ---------------------------------------------------------------------------

// Count phases from a phase string like "ABC" or "B".
const phaseCount = (phases) => Math.max(1, String(phases ?? "").replace(/[^ABC]/g, "").length);

// Direct labor hours (one person) to repair one damaged asset of assetType.
// asset: the GIS attributes of the matched asset (pole height, transformer size, phases).
// conditions: { accessIssue, specialEquipment } from the damage report, if any.
export function repairLaborHours(labor, assetType, asset, conditions = {}) {
  const recipe = labor.recipes[assetType];
  if (!recipe) return null;

  const hoursFor = (cu, mode) =>
    mode === "install" ? cu.install : mode === "remove" ? cu.remove : cu.install + cu.remove;

  let hours = 0;
  for (const [part, quantity, mode] of recipe) {
    let cu = labor.cu[part];
    let count = quantity === "perPhase" ? phaseCount(asset?.existing_p) : quantity;

    if (part === "pole") {
      const feet = Number.parseFloat(asset?.height ?? "") || 40;
      cu = labor.poleBySize.find((size) => feet <= size.maxFeet);
    } else if (part === "transformer" || part === "transformer833") {
      const specs = [asset?.a_phase_sp, asset?.b_phase_sp, asset?.c_phase_sp].filter(Boolean);
      const kva = part === "transformer833" ? 833 : Number.parseFloat(specs[0] ?? "") || 25;
      cu = labor.transformerByKva.reduce((a, b) => (Math.abs(b.kva - kva) < Math.abs(a.kva - kva) ? b : a));
      if (part === "transformer") count = specs.length || 1;
    }
    hours += hoursFor(cu, mode) * count;
  }

  // Add workbook adders for access problems and special equipment.
  const equipment = conditions.specialEquipment;
  if (conditions.accessIssue) hours += labor.adders.restrictedAccess.hours;
  if (equipment === "Backyard Bucket" || equipment === "Yard Dog") hours += labor.adders.confinedProperty.hours;
  else if (equipment === "Track Hoe" || equipment === "Backhoe") hours += labor.adders.remoteSite.hours;
  else if (equipment) hours += labor.adders.specializedHandling.hours;

  return Math.round(hours * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// 2. From labor hours to clock time
// ---------------------------------------------------------------------------

// Person-hours including drive, safety, and setup time ("crew-hours" in the outage panel).
export function crewHours(laborHours, indirectLaborMultiplier) {
  return laborHours * indirectLaborMultiplier;
}

// Clock hours for one crew to finish a repair.
export function repairClockHours(laborHours, indirectLaborMultiplier) {
  return crewHours(laborHours, indirectLaborMultiplier) / CREW_SIZE;
}

// ---------------------------------------------------------------------------
// 3. Storm forecast formulas
// ---------------------------------------------------------------------------

// Chance that something fails, given the storm's scale and its failure weight.
// Also used for a whole customer: their weight is the sum over every pole that
// can cut their power, which equals "at least one of those poles fails".
export function failureChance(stormScale, weight) {
  return 1 - Math.exp(-stormScale * weight);
}

// How long all crews together need to clear every expected repair in the storm.
// crews: override CREWS to explore staffing scenarios (the chatbot does this).
export function stormClearHours(totalRepairClockHours, crews = CREWS) {
  return totalRepairClockHours / crews;
}

// Repairs a customer's line needs if it loses power at all. Every failure between
// the home and the substation must be fixed before power returns, and given at
// least one failure, the expected count is weight / (1 - e^-weight).
// Used to explain the estimate; separate crews work these in parallel, so it
// doesn't add to hoursWithoutPower.
export function expectedRepairsOnPath(stormScale, weight) {
  const expected = stormScale * weight;
  return expected > 1e-6 ? expected / (1 - Math.exp(-expected)) : 1;
}

// Hours without power if a customer loses it: their own repair, plus waiting
// for their place in the storm backlog. queueShare (0-1) is how far through the
// backlog crews are when they reach the last repair on this customer's line
// (see prepareForecast in outages.js). Repairs that restore more customers go
// first, so repairs upstream of it are usually done by then.
export function hoursWithoutPower(ownRepairClockHours, clearHours, queueShare = 0.5) {
  return ownRepairClockHours + clearHours * queueShare;
}

// Build a planning range from repair work and an assumed place in the backlog.
// stepHours may include earlier repairs in the area's single-crew schedule.
// This is an assumption-based range, not a statistical confidence interval.
export function restorationRange(ownRepairHours, clearHours, queueShare = 0.5, stepHours = ownRepairHours) {
  return {
    lowHours: ownRepairHours,
    typicalHours: hoursWithoutPower(stepHours, clearHours, queueShare),
    highHours: stepHours + clearHours,
  };
}

// Combine the sampled area's restoration steps with the rest of the storm.
// The area's work already appears in stepHours, so exclude its labor from the
// outside backlog to avoid counting that same work a second time.
export function sampledRestorationRange({
  ownLineHours,
  stepHours,
  zoneLaborHours,
  stormLaborHours,
  repairsOnLine,
  accessLaborHours,
  multiplier,
  crews = CREWS,
  queueShare = 0.5,
}) {
  // Reject missing or invalid inputs instead of returning misleading durations.
  const workValues = [ownLineHours, stepHours, zoneLaborHours, stormLaborHours, repairsOnLine, accessLaborHours, multiplier];
  if (workValues.some(value => !Number.isFinite(value) || value < 0) || !Number.isFinite(crews) || crews <= 0) {
    throw new RangeError("Restoration work must be nonnegative and crew count must be positive.");
  }
  if (!Number.isFinite(queueShare) || queueShare < 0 || queueShare > 1) {
    throw new RangeError("Repair queue share must be between 0 and 1.");
  }

  // Apply the declared access allowance once per repair on the selected line.
  const accessHours = repairClockHours(accessLaborHours * repairsOnLine, multiplier);

  // Estimate how long the other storm work occupies the available crews.
  const otherLaborHours = Math.max(0, stormLaborHours - zoneLaborHours);
  const outsideBacklogHours = stormClearHours(repairClockHours(otherLaborHours, multiplier), crews);

  // The low case skips unrelated area jobs; the typical/high cases retain the
  // area's ordered repair steps and add a share/all of the outside backlog.
  return {
    ...restorationRange(ownLineHours + accessHours, outsideBacklogHours, queueShare, stepHours + accessHours),
    stepHours,
    accessHours,
    outsideBacklogHours,
  };
}

// ---------------------------------------------------------------------------
// 4. Step restoration for today's outages
// ---------------------------------------------------------------------------

// Order an outage's repairs the way crews restore power: a repair can't bring
// anyone back until every repair upstream of it is done, and among the repairs
// that are ready, the one serving the most customers per hour of work goes first.
// One crew works through them in turn.
// jobs: [{ id, hours, served, after }], where served = customers whose line runs
// through this repair and after = Set of job ids upstream of it.
// Returns the jobs in repair order, each with doneAfterHours from the start.
export function restorationOrder(jobs) {
  const priority = (job) => job.served / Math.max(job.hours, 0.1);
  const done = new Set();
  const pending = [...jobs];
  const order = [];
  let clock = 0;
  while (pending.length) {
    const ready = pending.filter((job) => [...job.after].every((id) => done.has(id)));
    const next = (ready.length ? ready : pending).reduce((a, b) => (priority(b) > priority(a) ? b : a));
    pending.splice(pending.indexOf(next), 1);
    done.add(next.id);
    clock += next.hours;
    order.push({ ...next, doneAfterHours: clock });
  }
  return order;
}

// The heatmap value: chance of losing power x hours it would last.
export function expectedHoursWithoutPower(chanceOut, hoursIfOut) {
  return chanceOut * hoursIfOut;
}
