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
// Calibrated to the Feb 12-17, 2025 storm's recorded repairs (report date to
// repair date: median 1 day, 75th percentile 2 days, 90th percentile 3 days).
// With the time sheet's job hours, 110 crews of 4 give that storm an average of
// about 2 days without power and finish every repair in about 2.9 days.
// Recalibrate if the job hours in labor.json change.
export const CREWS = 110;
export const CREW_SIZE = 4;

// ---------------------------------------------------------------------------
// 1. Labor hours for one repair, from public/data/labor.json (team time sheet jobs)
// ---------------------------------------------------------------------------

// Nearest kVA entry in a list of { kva, ... }.
const byKva = (list, kva) => list.reduce((a, b) => (Math.abs(b.kva - kva) < Math.abs(a.kva - kva) ? b : a));

// Transformer size from its GIS phase specs ("25 KVA" -> 25); 25 kVA if unknown.
export function transformerKva(asset) {
  const spec = [asset?.a_phase_sp, asset?.b_phase_sp, asset?.c_phase_sp].find(Boolean);
  return Number.parseFloat(spec ?? "") || 25;
}

// The team time sheet's job for one damaged asset (labor.jobs), or null when
// the sheet doesn't cover it. Damage reports carry an asset type but no damage
// type, so the job follows the asset.
// pole: for poles, { onPrimary, equipment, kva }: whether it carries primary
// line, and the equipment mounted on it ("Recloser Bank", "Transformer",
// "Switch", "Fuse Bank", or null) with the transformer's kVA.
export function repairJob(labor, assetType, asset, pole) {
  const jobs = labor.jobs;
  switch (assetType) {
    case "Pole":
      if (pole?.equipment === "Recloser Bank") return jobs.recloserBankPole;
      if (pole?.equipment === "Transformer") return byKva(jobs.transformerPole, pole.kva ?? 25);
      if (pole?.equipment === "Switch") return jobs.switchPole;
      if (pole?.equipment === "Fuse Bank") return jobs.fuseBankPole;
      return pole?.onPrimary === false ? jobs.secondaryPole : jobs.primaryPole;
    case "primary":
    case "secondary":
      return jobs.damagedWire;
    case "Transformer":
      return byKva(jobs.standaloneTransformer, transformerKva(asset));
    case "Fuse Bank":
      return jobs.fuseBank;
    case "Recloser Bank":
      return jobs.recloserBank;
    case "Capacitor Bank":
      return jobs.capacitorBank;
    case "Switch":
      return jobs.switch;
    default:
      return null;
  }
}

// Direct labor hours (one person) to repair one damaged asset of assetType:
// the time sheet's job, plus the workbook's adders.
// asset: the GIS attributes of the matched asset (transformer size, phases).
// conditions: { accessIssue, specialEquipment } from the damage report, plus
// for poles { pole: see repairJob, excavation: true if the site needs hand digging }.
export function repairLaborHours(labor, assetType, asset, conditions = {}) {
  const job = repairJob(labor, assetType, asset, conditions.pole);
  let hours;
  if (job) {
    hours = job.install + job.remove;
    if (job.setsPole && conditions.excavation) hours += labor.excavation.hours;
  } else {
    // Asset types the time sheet doesn't cover: build from workbook components.
    const recipe = labor.recipes[assetType];
    if (!recipe) return null;
    hours = 0;
    for (const [part, quantity, mode] of recipe) {
      const cu = part === "transformer833" ? byKva(labor.transformerByKva, 833) : labor.cu[part];
      hours += (mode === "install" ? cu.install : mode === "remove" ? cu.remove : cu.install + cu.remove) * quantity;
    }
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

// Clock hours of work for one crew to finish a repair (no breaks).
export function repairClockHours(laborHours, indirectLaborMultiplier) {
  return crewHours(laborHours, indirectLaborMultiplier) / CREW_SIZE;
}

// Lunch breaks from the team time sheet: 0.5 h for every 8 hours of continuous
// elapsed crew work.
export const LUNCH_BREAK_HOURS = 0.5;
export const LUNCH_EVERY_HOURS = 8;

// Elapsed clock hours for a stretch of continuous crew work, lunch breaks included.
// Applied once to each elapsed time below, never to a sum of already-converted times.
export function withLunchBreaks(workHours) {
  return workHours + LUNCH_BREAK_HOURS * Math.floor(workHours / LUNCH_EVERY_HOURS);
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
// Each crew works its share continuously, so lunch breaks apply to that share.
export function stormClearHours(totalRepairClockHours, crews = CREWS) {
  return withLunchBreaks(totalRepairClockHours / crews);
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
// clearHours already includes lunch breaks (stormClearHours).
export function hoursWithoutPower(ownRepairClockHours, clearHours, queueShare = 0.5) {
  return withLunchBreaks(ownRepairClockHours) + clearHours * queueShare;
}

// Build a planning range from repair work and an assumed place in the backlog.
// ownRepairHours: work hours (no breaks) on this customer's own line.
// stepHours: elapsed hours until the area's single-crew schedule reaches this
// customer, lunch breaks included (restorationOrder's doneAfterHours).
// This is an assumption-based range, not a statistical confidence interval.
export function restorationRange(ownRepairHours, clearHours, queueShare = 0.5, stepHours = withLunchBreaks(ownRepairHours)) {
  return {
    lowHours: withLunchBreaks(ownRepairHours),
    typicalHours: stepHours + clearHours * queueShare,
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
// anyone back until every repair upstream of it is done. Among the repairs that
// are ready, one that restores a priority location (hospital, fire or ambulance
// station) goes first, then the one serving the most customers per hour of work.
// One crew works through them in turn.
// jobs: [{ id, hours, served, after, priority }], where served = customers whose
// line runs through this repair, after = Set of job ids upstream of it, and
// priority = priority locations it restores (optional).
// Returns the jobs in repair order, each with workDoneHours (work so far, no
// breaks) and doneAfterHours (elapsed, lunch breaks included) from the start.
export function restorationOrder(jobs) {
  const rate = (job) => job.served / Math.max(job.hours, 0.1);
  const first = (a, b) => ((b.priority > 0) !== (a.priority > 0) ? b.priority > 0 : rate(b) > rate(a));
  const done = new Set();
  const pending = [...jobs];
  const order = [];
  let clock = 0;
  while (pending.length) {
    const ready = pending.filter((job) => [...job.after].every((id) => done.has(id)));
    const next = (ready.length ? ready : pending).reduce((a, b) => (first(a, b) ? b : a));
    pending.splice(pending.indexOf(next), 1);
    done.add(next.id);
    clock += next.hours;
    // The crew works continuously, so lunch breaks apply to the running total.
    order.push({ ...next, workDoneHours: clock, doneAfterHours: withLunchBreaks(clock) });
  }
  return order;
}

// The heatmap value: chance of losing power x hours it would last.
export function expectedHoursWithoutPower(chanceOut, hoursIfOut) {
  return chanceOut * hoursIfOut;
}
