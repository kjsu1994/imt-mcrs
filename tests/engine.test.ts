import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SimulationEngine,
  createScenario,
  SECOND,
  validateScenario,
  normalizeScenario,
  DEFAULT_EPOCH_MS,
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
  assert.equal(e.result().serviceOutages[0].detectedUs, null);
  e.advanceTo(1200000);
  assert.equal(e.result().serviceOutages[0].detectedUs, 1200000);
  e.advanceTo(1201999);
  assert.equal(e.result().serviceOutages[0].recoveredUs, null);
  e.advanceTo(1202000);
  assert.deepEqual(e.snapshot().path, [0, 7, 6, 5, 4, 3]);
  assert.equal(e.result().serviceOutages[0].recoveryUs, 202000);
  assert.equal(e.result().serviceOutages[0].establishmentUs, 2000);
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
    assert.equal(e.result().serviceOutages[0].detectedUs, null);
    assert.equal(e.result().serviceOutages[0].recoveredUs, up);
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
  assert.equal(e.result().serviceOutages[0].status, "unrecovered");
  assert.equal(e.result().outageCount, 1);
  assert.equal(e.result().linkFailures.length, 2);
  assert.equal(e.result().meanOutageUs, null);
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

test("overlapping link failures form one service outage without negative establishment", () => {
  const s = scenario();
  s.failures = [
    { atUs: SECOND, linkId: "0:1", down: true },
    { atUs: 1050000, linkId: "1:2", down: true },
  ];
  const e = new SimulationEngine(s);
  e.advanceTo(1100000);
  assert.equal(e.result().totalDowntimeUs, 100000);
  e.advanceTo(s.durationUs);
  const r = e.result();
  assert.equal(r.linkFailures.length, 2);
  assert.equal(r.serviceOutages.length, 1);
  assert.equal(r.outageCount, 1);
  assert.deepEqual(r.serviceOutages[0].causeLinkIds, ["0:1", "1:2"]);
  assert.equal(r.serviceOutages[0].recoveryUs, 202000);
  assert.equal(r.serviceOutages[0].establishmentUs, 2000);
  assert.equal(r.totalDowntimeUs, 202000);
  assert.equal(r.meanOutageUs, 202000);
  assert.equal(r.availability, 1 - 202000 / s.durationUs);
  assert.equal(r.events.filter((x) => x.type === "service-restored").length, 1);
  assert.equal(r.linkFailures[1].detectedUs, 1300000);
  assert.equal(r.linkFailures[1].restoredUs, null);
});
test("unrelated failures do not interrupt service, repeat interruptions count separately", () => {
  const s = scenario();
  s.failures = [
    { atUs: 500000, linkId: "0:7", down: true },
    { atUs: 1000000, linkId: "0:1", down: true },
    { atUs: 1050000, linkId: "0:1", down: false },
    { atUs: 1500000, linkId: "0:1", down: true },
    { atUs: 1550000, linkId: "0:1", down: false },
  ];
  const e = new SimulationEngine(s);
  e.advanceTo(s.durationUs);
  const r = e.result();
  assert.equal(r.outageCount, 2);
  assert.equal(r.totalDowntimeUs, 100000);
  assert.equal(r.meanOutageUs, 50000);
  assert.ok(
    r.serviceOutages.every(
      (o) => o.detectedUs === null && o.establishmentUs === null,
    ),
  );
  assert.ok(r.serviceOutages.every((o) => o.causeLinkIds.join() === "0:1"));
  assert.equal(r.linkFailures.length, 3);
});
test("initial unreachable, zero exposure, identity and endpoint events have explicit availability", () => {
  const s = {
    ...scenario(),
    config: { ...ring, perPlane: 2, altitude: 550 },
    target: 1,
  };
  const e = new SimulationEngine(s);
  assert.equal(e.result().availability, null);
  assert.equal(e.result().serviceOutages[0].reason, "initial-unreachable");
  assert.deepEqual(e.result().serviceOutages[0].previousPath, []);
  e.advanceTo(s.durationUs);
  assert.equal(e.result().initialOutageCount, 1);
  assert.equal(e.result().totalDowntimeUs, s.durationUs);
  assert.equal(e.result().availability, 0);
  assert.equal(e.result().unrecoveredCount, 1);
  const local = new SimulationEngine({ ...s, target: 0 });
  local.advanceTo(s.durationUs);
  assert.equal(local.result().availability, 1);
  assert.equal(local.result().outageCount, 0);
  const boundary = new SimulationEngine({
    ...scenario(),
    failures: [{ atUs: 3000000, linkId: "0:1", down: true }],
  });
  boundary.advanceTo(3000000);
  assert.equal(boundary.result().serviceOutages[0].startedUs, 3000000);
  assert.equal(boundary.result().outageCount, 0);
  assert.equal(boundary.result().availability, 1);
});
test("geometry and forced restoration at 106 seconds commit one physical state", () => {
  const config = {
    planes: 6,
    perPlane: 12,
    altitude: 550,
    inclination: 53,
    phase: 1,
  };
  const s = {
    ...createScenario(config, DEFAULT_EPOCH_MS, 51, 63),
    durationUs: 107 * SECOND,
    failures: [
      { atUs: 105500000, linkId: "51:63", down: true },
      { atUs: 106000000, linkId: "51:63", down: false },
    ],
  };
  for (const budget of [1, 500]) {
    const e = new SimulationEngine(s);
    while (!e.advanceTo(106000000, budget)) {}
    assert.equal(
      e.snapshot().links.find((l) => l.id === "51:63")!.physical,
      false,
    );
    const at = e
      .result()
      .events.filter((x) => x.atUs === 106000000 && x.linkId === "51:63");
    assert.ok(!at.some((x) => x.type === "link-up" || x.type === "link-down"));
    const changes = e
      .drainDeltas()
      .filter((x) => x.timeUs === 106000000)
      .flatMap((d) => d.changedLinks)
      .filter((l) => l.id === "51:63");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].forced, false);
    assert.equal(changes[0].physical, false);
  }
});
test("legacy scenarios retain parameters and reject unsupported versions and UTC overflow", () => {
  const { schemaVersion, ...legacy } = scenario();
  assert.equal(normalizeScenario(legacy).schemaVersion, 9);
  assert.equal(normalizeScenario(legacy).epochMs, legacy.epochMs);
  const a = new SimulationEngine(legacy),
    b = new SimulationEngine({ ...legacy, schemaVersion: 2 });
  a.advanceTo(legacy.durationUs);
  b.advanceTo(legacy.durationUs);
  assert.deepEqual(a.result(), b.result());
  assert.equal(a.result().modelVersion, "mcsr-ground-v9");
  assert.throws(() => normalizeScenario({ ...legacy, schemaVersion: 99 }));
  assert.throws(() =>
    normalizeScenario({ ...legacy, epochMs: 8640000000000000 }),
  );
});

test("geometry becoming visible and forced restoration produce one up transition", () => {
  const config = {
    planes: 6,
    perPlane: 12,
    altitude: 550,
    inclination: 53,
    phase: 1,
  };
  const e = new SimulationEngine({
    ...createScenario(config, DEFAULT_EPOCH_MS, 49, 61),
    durationUs: 136000000,
    failures: [
      { atUs: 134500000, linkId: "49:61", down: true },
      { atUs: 135000000, linkId: "49:61", down: false },
    ],
  });
  e.advanceTo(135000000);
  const transitions = e
    .result()
    .events.filter(
      (x) =>
        x.atUs === 135000000 &&
        x.linkId === "49:61" &&
        ["link-up", "link-down"].includes(x.type),
    );
  assert.deepEqual(
    transitions.map((x) => x.type),
    ["link-up"],
  );
  assert.equal(
    e.snapshot().links.find((l) => l.id === "49:61")!.physical,
    true,
  );
});
test("one path link restoring while another fails at the same instant cannot end an outage", () => {
  const s = {
    ...scenario(),
    computeDelayUs: 2000000,
    failures: [
      { atUs: 500000, linkId: "0:1", down: true },
      { atUs: 1000000, linkId: "0:1", down: false },
      { atUs: 1000000, linkId: "1:2", down: true },
    ],
  };
  const e = new SimulationEngine(s);
  e.advanceTo(1100000);
  assert.equal(e.result().serviceOutages.length, 1);
  assert.equal(e.result().serviceOutages[0].recoveredUs, null);
  assert.deepEqual(e.result().serviceOutages[0].causeLinkIds, ["0:1", "1:2"]);
  assert.ok(!e.result().events.some((x) => x.type === "service-restored"));
});

test("reinstalling the original path after an empty route is algorithmic recovery", () => {
  const s = scenario();
  s.failures = [
    { atUs: SECOND, linkId: "0:1", down: true },
    { atUs: SECOND, linkId: "0:7", down: true },
    { atUs: 2 * SECOND, linkId: "0:1", down: false },
    { atUs: 2 * SECOND, linkId: "0:7", down: false },
  ];
  const e = new SimulationEngine(s);
  e.advanceTo(s.durationUs);
  const outage = e.result().serviceOutages[0];
  assert.deepEqual(outage.previousPath, outage.restoredPath);
  assert.equal(outage.recoveryMechanism, "recalculate");
  assert.equal(outage.recoveredUs, 2002000);
});
test("physical restoration before a same-time replacement install remains physical recovery", () => {
  const s = scenario();
  s.computeDelayUs = 50000;
  s.installDelayUs = 0;
  s.failures = [
    { atUs: SECOND, linkId: "0:1", down: true },
    { atUs: 1250000, linkId: "0:1", down: false },
  ];
  const e = new SimulationEngine(s);
  e.advanceTo(s.durationUs);
  const outage = e.result().serviceOutages[0];
  assert.notDeepEqual(outage.previousPath, outage.restoredPath);
  assert.equal(outage.recoveredUs, 1250000);
  assert.equal(outage.recoveryMechanism, "physical-restoration");
});
