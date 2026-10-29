import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeScenario, SimulationEngine } from "../src/engine";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Frozen 1635f54 results matched ea90994 before becoming regression expectations.
for (const [size, inputHash, resultHash] of [
  [
    72,
    "80a27c77903d670c62ffc8fabe808f74abcbb18f47a71eb661b8d0191a0e36a8",
    "717d69eb44f54af443cbee248ced3353e2c4276bc3735e2a03aaf5a232c9fc46",
  ],
  [
    1584,
    "0184caf8307b3e5e9011808903f0619a4848ec165a3e2c4f57e37eb8a223749b",
    "d2212a10975e355c3512ca6f67b7ac820fb2de9ac7035daa610b9c23cc12e1ab",
  ],
] as const) {
  test(`${size}-satellite MCSR preserves the frozen 31-second logical result`, () => {
    const scenario = normalizeScenario(
      JSON.parse(readFileSync(`examples/mcsr-${size}.json`, "utf8")),
    );
    scenario.durationUs = 31000000;
    scenario.failures = scenario.failures.filter(
      (event) => event.atUs <= scenario.durationUs,
    );
    scenario.linkMetricUpdates = scenario.linkMetricUpdates.filter(
      (event) => event.atUs <= scenario.durationUs,
    );
    assert.equal(hash(scenario), inputHash, "Frozen scenario input changed");
    const engine = new SimulationEngine(scenario, undefined, true, {
      render: false,
    });
    while (!engine.advanceTo(scenario.durationUs, 500)) engine.drainDeltas();
    const result = engine.result();
    assert.equal(result.completed, true);
    assert.equal(result.validForAnalysis, true);
    assert.equal(
      hash(result),
      resultHash,
      "Logical result changed: inspect routes, D/A/J, CSIB/ACK order and recovery times",
    );
  });
}
