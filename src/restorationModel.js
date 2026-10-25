// Restoration-time model: the ONE place every repair-time and outage-length
// number in the app comes from. Change a formula here and it changes everywhere:
//   - scripts/dataBuildScripts/build-outage-grid.js uses repairLaborHours
//     (re-run `npm run data:grid` after changing it, since results are stored in grid.json)
//   - src/outages.js uses the rest for today's outages and the storm forecast
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
export function stormClearHours(totalRepairClockHours) {
  return totalRepairClockHours / CREWS;
}

// Hours without power if a customer loses it: their own repair, plus on average
// waiting for half the storm backlog before a crew reaches them.
export function hoursWithoutPower(ownRepairClockHours, clearHours) {
  return ownRepairClockHours + clearHours / 2;
}

// The heatmap value: chance of losing power x hours it would last.
export function expectedHoursWithoutPower(chanceOut, hoursIfOut) {
  return chanceOut * hoursIfOut;
}
