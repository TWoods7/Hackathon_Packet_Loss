import assert from "node:assert/strict";
import test from "node:test";
import { stormLevel } from "../src/stormLevels.js";

let moduleNumber = 0;

// Isolate registered map state while exercising the real assistant tool exports.
async function freshTools() {
  const url = new URL("../src/assistantTools.js", import.meta.url);
  url.searchParams.set("coverage-test", String(++moduleNumber));
  return import(url.href);
}

// Reading any nearby-customer or simulation data outside coverage is a test failure.
function uncoveredMap() {
  const reads = [];
  const forbidden = (name) => () => {
    reads.push(name);
    throw new Error(`Unexpected outside-coverage data access: ${name}`);
  };
  const selected = { covered: false, formattedAddress: "A customer-provided address outside coverage" };
  for (const name of ["customer", "distance"]) {
    Object.defineProperty(selected, name, { get: forbidden(name) });
  }
  const api = {
    getSelection: () => selected,
    searchAddress: async () => selected,
  };
  for (const name of ["grid", "forecastInputs", "zoneByCustomer", "stepOfCustomer"]) {
    Object.defineProperty(api, name, { get: forbidden(name) });
  }
  for (const name of ["getSeverity", "getStormLevel", "getScenario", "getRepairConditions", "damageSummary"]) {
    api[name] = forbidden(name);
  }
  return { api, reads };
}

function assertUncovered(result) {
  assert.equal(result.error, "This area is not covered.");
  assert.equal(result.covered, false);
  assert.equal(result.confidence, "low");
  assert.equal(result.reliable_match, false);
  assert.equal(result.has_network_data, false);
  assert.match(result.note, /official outage map|contact the utility/);
  for (const field of [
    "current_status", "power", "simulated_power", "risk_band", "chance_of_outage",
    "low_hours", "typical_hours", "high_hours", "restoration_range_hours",
    "eligible", "priority_escalation", "messages", "storm_level", "customer",
  ]) {
    assert.equal(Object.hasOwn(result, field), false, `must omit ${field}`);
  }
}

test("all selected-location tools stop before reading a nearby customer's data outside coverage", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches++;
    throw new Error("An uncovered location must not load simulation data");
  });
  const tools = await freshTools();
  const map = uncoveredMap();
  tools.registerMapApi(map.api);
  const requests = [
    ["search_address", { address: "address outside coverage" }],
    ["get_current_status", {}],
    ["get_outage_risk", { storm_level: "major_storm" }],
    ["estimate_restoration", { storm_level: "major_storm", crews: 40, access_issue: true }],
    ["check_alert_eligibility", { declared_needs: ["medical_equipment"] }],
    ["draft_notifications", { declared_needs: ["critical_facility"] }],
  ];
  for (const [name, input] of requests) {
    const response = await tools.runTool({ id: name, name, input });
    assert.equal(response.type, "tool_result");
    assert.equal(response.tool_use_id, name);
    assert.equal(response.is_error, true);
    assertUncovered(JSON.parse(response.content));
  }
  assert.deepEqual(map.reads, []);
  assert.equal(fetches, 0);
});

test("the notification button's direct export also blocks uncovered predictions", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected fetch"); });
  const tools = await freshTools();
  const map = uncoveredMap();
  tools.registerMapApi(map.api);
  assertUncovered(await tools.draftNotifications({ declared_needs: ["medical_equipment"] }));
  assert.deepEqual(map.reads, []);
});

test("handoff keeps declared safety information but includes no uncovered simulation claims", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected fetch"); });
  const tools = await freshTools();
  const map = uncoveredMap();
  tools.registerMapApi(map.api);
  const summary = await tools.handoffSummary({
    declared_needs: ["medical_equipment"],
    safety_flags: ["downed line reported"],
  });
  assertUncovered(summary);
  assert.equal(summary.location, "A customer-provided address outside coverage");
  assert.deepEqual(summary.declared_needs, ["medical_equipment"]);
  assert.ok(summary.reasons.includes("downed line reported"));
  assert.ok(summary.reasons.some((reason) => reason.includes("medical equipment")));
  assert.deepEqual(map.reads, []);
});

test("covered and legacy selections still return the normal simulated status", async () => {
  const tools = await freshTools();
  for (const covered of [true, undefined]) {
    const selected = { customer: { index: 0 }, distance: 20, formattedAddress: "Inside coverage", covered };
    tools.registerMapApi({
      getSelection: () => selected,
      grid: { customerChains: [[0]], meta: { worstStorm: { lineDamage: 550 } } },
      forecastInputs: { exposure: [1], hasHistory: [true] },
      zoneByCustomer: new Map(),
      getStormLevel: () => stormLevel("calm"),
      getSeverity: () => 0,
    });
    const response = await tools.runTool({ id: "covered", name: "get_current_status", input: {} });
    assert.equal(response.is_error, false, response.content);
    const status = JSON.parse(response.content);
    assert.equal(status.power, "on");
    assert.equal(status.scenario, "simulated storm");
    assert.equal(status.is_calm, true);
  }
});
