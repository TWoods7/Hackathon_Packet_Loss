// Named storm levels for the map slider and the assistant. Storm strength is
// measured by expected broken poles and wires, the quantity the forecast is
// calibrated on. The forecast itself still takes severity (0-1) = share of the
// worst storm's line damage, so these levels only change how storms are named.
//
// Counts for the storms named here come from this area's damage reports
// (2022-2026), grouped into storms the way build-outage-grid.js does: days with
// 10+ reports, gaps of up to 2 days. Event names (Helene, the January winter
// storm) are matched by date; the reports themselves don't name storms.
// Ordinary thunderstorm days in the reports break 7-16 poles and wires.
// Levels are spaced so everyday storms get their own stops instead of being
// squeezed into the first few percent of a linear scale.
// Plain JavaScript (no browser or Node APIs): server/prompt.js imports it too.

export const STORM_LEVELS = [
  { id: "calm", name: "Calm", lineDamage: 0, like: "ordinary weather, including light rain" },
  { id: "light_thunderstorm", name: "Light thunderstorm", lineDamage: 5, like: "a passing thunderstorm" },
  { id: "thunderstorm", name: "Thunderstorm", lineDamage: 10, like: "a typical storm day, such as May 27, 2024" },
  { id: "strong_thunderstorm", name: "Strong thunderstorm", lineDamage: 16, like: "the April 12, 2024 storm" },
  { id: "winter_storm", name: "Winter storm", lineDamage: 33, like: "the January 6-7, 2025 snow and ice storm" },
  { id: "severe_storm", name: "Severe storm", lineDamage: 75, like: "a storm with about twice the damage of the January 2025 winter storm" },
  { id: "major_storm", name: "Major storm", lineDamage: 157, like: "the remnants of Hurricane Helene, Sept. 27 - Oct. 2, 2024" },
  { id: "very_severe_storm", name: "Very severe storm", lineDamage: 300, like: "a storm with about twice the damage Helene caused here" },
  { id: "extreme_storm", name: "Extreme storm", lineDamage: 550, like: "a storm with more than three times the damage Helene caused here" },
  // null: always the worst storm in the loaded data (grid.meta.worstStorm).
  { id: "worst_on_record", name: "Worst on record", lineDamage: null, like: "the February 12-17, 2025 storms (ice, flooding, and high winds)" },
];

export const STORM_LEVEL_IDS = STORM_LEVELS.map((level) => level.id);

// The level with this id, or undefined.
export function stormLevel(id) {
  return STORM_LEVELS.find((level) => level.id === id);
}

// Expected broken poles and wires for a level.
export function levelLineDamage(level, worstStorm) {
  return level.lineDamage ?? worstStorm.lineDamage;
}

// Forecast severity (0-1) for a level.
export function levelSeverity(level, worstStorm) {
  return Math.min(1, levelLineDamage(level, worstStorm) / worstStorm.lineDamage);
}
