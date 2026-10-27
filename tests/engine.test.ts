import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SimulationEngine,
  createScenario,
  SECOND,
  validateScenario,
} from "../src/engine.ts";
const ring = {
  planes: 1,
  perPlane: 8,
  altitude: 2000,
  inclination: 0,
  phase: 0,
};
function scenario() {
  return {
    ...createScenario(ring, Date.UTC(2026, 0, 1), 0, 3),
    durationUs: 3 * SECOND,
  };
}
test("three SLS misses then fixed compute and install delays", () => {
  const s = scenario();
  s.failures = [{ atUs: SECOND, linkId: "0:1", down: true }];
  const e = new SimulationEngine(s);
  e.advanceTo(1000000);
  assert.equal(e.snapshot().links.find((l) => l.id === "0:1")!.physical, false);
  assert.equal(e.snapshot().links.find((l) => l.id === "0:1")!.known, true);
  e.advanceTo(1199999);
  assert.equal(e.result().recoveries[0].detectedUs, null);
  e.advanceTo(1200000);
  assert.equal(e.result().recoveries[0].detectedUs, 1200000);
  e.advanceTo(1201999);
  assert.equal(e.result().recoveries[0].recoveredUs, null);
  e.advanceTo(1202000);
  assert.deepEqual(e.snapshot().path, [0, 7, 6, 5, 4, 3]);
  assert.equal(e.result().recoveries[0].recoveryUs, 202000);
  assert.equal(e.result().recoveries[0].establishmentUs, 2000);
});
test("one or two missed messages do not declare failure, receive resets counter", () => {
  for (const up of [1050000, 1150000]) {
    const s = scenario();
    s.failures = [
      { atUs: SECOND, linkId: "0:1", down: true },
      { atUs: up, linkId: "0:1", down: false },
    ];
    const e = new SimulationEngine(s);
    e.advanceTo(s.durationUs);
    assert.equal(e.result().recoveries[0].detectedUs, null);
    assert.equal(e.result().recoveries[0].recoveredUs, up);
    assert.deepEqual(e.snapshot().path, [0, 1, 2, 3]);
    assert.ok(!e.result().events.some((v) => v.type === "link-detected-down"));
  }
});
test("logical results are identical across pacing, presentation and event batch sizes", () => {
  const s = scenario();
  s.failures = [
    { atUs: SECOND, linkId: "0:1", down: true },
    { atUs: 2100000, linkId: "0:1", down: false },
  ];
  const reference = new SimulationEngine(s);
  reference.advanceTo(s.durationUs);
  for (const increment of [1000, 16667, 100000, 3000000])
    for (const budget of [1, 5, 500]) {
      const e = new SimulationEngine(s);
      for (let t = increment; ; t += increment) {
        const target = Math.min(t, s.durationUs);
        while (!e.advanceTo(target, budget)) {}
        if (target === s.durationUs) break;
      }
      assert.deepEqual(e.result(), reference.result());
    }
});
test("partition remains unrecovered, unrelated failures are not averaged as zero", () => {
  const s = scenario();
  s.failures = [
    { atUs: SECOND, linkId: "0:1", down: true },
    { atUs: SECOND, linkId: "0:7", down: true },
  ];
  const e = new SimulationEngine(s);
  e.advanceTo(s.durationUs);
  assert.deepEqual(e.snapshot().path, []);
  assert.equal(e.result().recoveries[0].status, "unrecovered");
  assert.equal(e.result().recoveries[1].status, "unaffected");
  assert.equal(e.result().meanRecoveryUs, null);
});
test("new known topology discards stale computations and installs latest path only", () => {
  const s = { ...scenario(), computeDelayUs: 500000 };
  s.failures = [
    { atUs: SECOND, linkId: "0:1", down: true },
    { atUs: 1250000, linkId: "0:7", down: true },
  ];
  const e = new SimulationEngine(s);
  e.advanceTo(s.durationUs);
  assert.ok(
    e
      .result()
      .events.some((v) => v.type === "route-discarded" && v.atUs === 1700000),
  );
  assert.deepEqual(e.snapshot().path, []);
});
test("manual schedule export, backward replay and stepping are reproducible", () => {
  const s = scenario(),
    e = new SimulationEngine(s);
  e.advanceTo(500000);
  e.addFailure({ atUs: SECOND, linkId: "0:1", down: true });
  e.advanceTo(s.durationUs);
  const replay = new SimulationEngine(e.scenario);
  replay.advanceTo(s.durationUs);
  assert.deepEqual(e.result(), replay.result());
  const stepped = new SimulationEngine(e.scenario);
  while (stepped.nowUs < s.durationUs) stepped.step();
  assert.deepEqual(stepped.result(), e.result());
  assert.throws(() => e.advanceTo(1));
});
test("scenario boundary rejects bad times, nodes, links and conflicting schedules", () => {
  const s = scenario();
  assert.throws(() => validateScenario({ ...s, slsIntervalUs: 0 }));
  assert.throws(() => validateScenario({ ...s, source: 8 }));
  assert.throws(() =>
    validateScenario({
      ...s,
      failures: [{ atUs: 1, linkId: "0:99", down: true }],
    }),
  );
  assert.throws(() =>
    validateScenario({
      ...s,
      failures: [
        { atUs: 1, linkId: "0:1", down: true },
        { atUs: 1, linkId: "0:1", down: false },
      ],
    }),
  );
  const e = new SimulationEngine(s);
  assert.throws(() => e.addFailure({ atUs: 0, linkId: "0:1", down: true }));
  assert.equal(s.failures.length, 0);
});
