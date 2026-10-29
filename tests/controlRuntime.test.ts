import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SimulationEngine,
  normalizeScenario,
  createScenario,
  DEFAULT_EPOCH_MS,
} from "../src/engine.ts";
import { TopologyStream } from "../src/topologyStream.ts";
const example = () =>
  JSON.parse(readFileSync("examples/mcsr-routing.json", "utf8"));
test("v7 requires control settings and v6 keeps the fixed delivery model", () => {
  const old = JSON.parse(
    readFileSync("examples/mcsr-fixed-routing.json", "utf8"),
  );
  const migrated = normalizeScenario(old);
  assert.deepEqual(migrated.controlTransport, {
    mode: "fixed",
    ackTimeoutUs: 1000000,
  });
  assert.equal(migrated.schemaVersion, 8);
  const normalized = new SimulationEngine(migrated),
    legacy = new SimulationEngine(old);
  normalized.advanceTo(old.durationUs);
  legacy.advanceTo(old.durationUs);
  assert.deepEqual(normalized.result(), legacy.result());
  assert.equal(
    createScenario(old.config, DEFAULT_EPOCH_MS).controlTransport.mode,
    "isl",
  );
  for (const controlTransport of [
    undefined,
    { mode: "bogus", ackTimeoutUs: 1 },
    { mode: "isl", ackTimeoutUs: 0 },
    { mode: "isl", ackTimeoutUs: Infinity },
  ])
    assert.throws(() => normalizeScenario({ ...example(), controlTransport }));
});
test("remote failure is unknown to the source until the actual update arrives; spare recovery has distinct stages", () => {
  const s = example(),
    e = new SimulationEngine(s);
  e.advanceTo(1250000);
  assert.ok(e.graph().links.some((l) => l.id === "10:11" && l.knownAvailable));
  assert.equal(e.result().serviceOutages[0].detectedUs, 1200000);
  assert.equal(e.result().serviceOutages[0].sourceInformedUs, null);
  e.advanceTo(s.durationUs);
  const r = e.result(),
    outage = r.serviceOutages[0];
  assert.equal(r.validForAnalysis, true);
  assert.equal(outage.recoveryMechanism, "reserve");
  assert.equal(outage.sourceInformedUs, 1338399);
  assert.equal(outage.recoveryUs, 341399);
  assert.equal(outage.informedEstablishmentUs, 3000);
  assert.ok(r.mcsr!.control!.stats.retries > 0);
  assert.ok(r.mcsr!.control!.events.some((e) => e.type === "dropped"));
  assert.ok(r.serviceOutages[1].recoveredUs! > 3000000);
  assert.equal(r.serviceOutages[1].recoveryMechanism, "recalculate");
});
test("physical restoration is not classified as an algorithmic route recovery", () => {
  const s = example();
  s.failures = [
    { atUs: 1100000, linkId: "10:11", down: true },
    { atUs: 1150000, linkId: "10:11", down: false },
  ];
  const e = new SimulationEngine(s);
  e.advanceTo(1500000);
  const r = e.result().serviceOutages[0];
  assert.equal(r.recoveryMechanism, "physical-restoration");
  assert.equal(r.recoveryUs, 50000);
  assert.equal(r.sourceInformedUs, null);
  assert.equal(r.detectedUs, null);
});
test("ISL messages and metrics replay identically across steps and event budgets", () => {
  const s = example(),
    direct = new SimulationEngine(s);
  direct.advanceTo(s.durationUs);
  const expected = direct.result();
  for (const budget of [1, 500]) {
    const e = new SimulationEngine(s);
    while (!e.advanceTo(s.durationUs, budget)) e.drainDeltas();
    assert.deepEqual(e.result(), expected);
  }
  const stepped = new SimulationEngine(s);
  while (stepped.nowUs < s.durationUs) {
    stepped.step();
    stepped.drainDeltas();
  }
  assert.deepEqual(stepped.result(), expected);
});
test("control departures, arrivals and failures appear only at the correct display time", () => {
  const e = new SimulationEngine(example()),
    stream = new TopologyStream();
  stream.reset(e.checkpoint());
  e.advanceTo(1100000);
  stream.receive(e.drainDeltas());
  assert.ok(stream.matches(e.checkpoint()));
  assert.equal(stream.at(999999)!.mcsr!.control!.flights.length, 0);
  assert.ok(stream.at(1000000)!.mcsr!.control!.flights.length > 0);
  assert.ok(
    stream
      .at(1010000)!
      .mcsr!.control!.events.some((e) => e.type === "hop-started"),
  );
  assert.ok(stream.at(1100000)!.mcsr!.control!.stats.dropped > 0);
});
test("control event limit marks the engine invalid instead of exporting success", () => {
  const s = example();
  s.durationUs = 2000000;
  s.failures = [];
  s.controlTransport.ackTimeoutUs = 1;
  const e = new SimulationEngine(s);
  assert.throws(() => {
    while (!e.advanceTo(s.durationUs, 200)) {
      e.drainDeltas();
    }
  }, /100,000/);
  assert.equal(e.failure?.code, "control-event-limit");
  assert.equal(e.result().validForAnalysis, false);
  assert.equal(e.result().completed, false);
  assert.throws(() => e.step());
});
