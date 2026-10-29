import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bfsStrategy,
  linkMetrics,
  extendMetrics,
  evaluatePath,
  LIGHT_SPEED_M_S,
  DEFAULT_LINK_LOAD,
} from "../src/routing.ts";
import type { RoutingGraph, RoutingStrategy } from "../src/routing.ts";
import {
  SimulationEngine,
  createScenario,
  DEFAULT_EPOCH_MS,
  SECOND,
  normalizeScenario,
} from "../src/engine.ts";
const ring = {
  planes: 1,
  perPlane: 8,
  altitude: 2000,
  inclination: 0,
  phase: 0,
};
const scenario = () => ({
  ...createScenario(ring, DEFAULT_EPOCH_MS, 0, 3),
  durationUs: 3 * SECOND,
});
const update = (atUs = 0) => ({
  atUs,
  linkId: "0:1",
  bufferCapacityPackets: 1000,
  queuedPackets: 800,
  jitterMs: 2,
});
const link = (a: number, b: number, d: number, buffer = 1, jitter = 0) => ({
  id: `${a}:${b}`,
  sourceId: a,
  targetId: b,
  knownAvailable: true,
  metrics: {
    propagationDelayMs: d,
    availableBufferRatio: buffer,
    jitterMs: jitter,
  },
});

test("link D uses metres and light speed; A uses queue occupancy", () => {
  assert.deepEqual(
    linkMetrics(
      { x: 0, y: 0, z: 0 },
      { x: LIGHT_SPEED_M_S / 1000, y: 0, z: 0 },
      update(),
    ),
    {
      propagationDelayMs: 1,
      availableBufferRatio: 0.2,
      jitterMs: 2,
    },
  );
  assert.equal(
    linkMetrics({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, DEFAULT_LINK_LOAD)
      .availableBufferRatio,
    1,
  );
});
test("path extension sums D, minimises A, maximises J in both directions", () => {
  const a = link(0, 1, 10, 0.7, 2),
    b = link(1, 2, 15, 0.9, 1);
  assert.deepEqual(extendMetrics(a.metrics, b.metrics), {
    propagationDelayMs: 25,
    availableBufferRatio: 0.7,
    jitterMs: 2,
  });
  assert.deepEqual(evaluatePath([2, 1, 0], [a, b]), {
    nodes: [2, 1, 0],
    propagationDelayMs: 25,
    availableBufferRatio: 0.7,
    jitterMs: 2,
  });
  assert.equal(evaluatePath([0, 2], [a, b]), null);
  assert.equal(evaluatePath([0, 1], [{ ...a, knownAvailable: false }]), null);
});
test("BFS keeps hop and tie order regardless of attributes and handles isolated endpoints", () => {
  const graph: RoutingGraph = {
    nodeCount: 5,
    links: [
      link(0, 1, 100, 0.1, 9),
      link(1, 3, 100),
      link(0, 2, 1),
      link(2, 3, 1),
    ],
  };
  assert.deepEqual(bfsStrategy.calculate(graph, 0, 3)[0].nodes, [0, 1, 3]);
  assert.deepEqual(bfsStrategy.calculate(graph, 0, 4), []);
  assert.deepEqual(bfsStrategy.calculate(graph, -1, 0), []);
  assert.deepEqual(bfsStrategy.calculate(graph, 4, 4), [
    { nodes: [4], propagationDelayMs: 0, availableBufferRatio: 1, jitterMs: 0 },
  ]);
});
test("v4 validation and legacy migration preserve deterministic defaults", () => {
  const { schemaVersion, linkMetricUpdates, ...legacy } = scenario();
  for (const version of [undefined, 1, 2, 3]) {
    const s = normalizeScenario({
      ...legacy,
      ...(version === undefined ? {} : { schemaVersion: version }),
      ...(version === 3 ? { linkMetricUpdates: [] } : {}),
    });
    assert.equal(s.schemaVersion, 8);
    assert.deepEqual(s.linkMetricUpdates, []);
  }
  for (const bad of [
    null,
    { ...update(), atUs: -1 },
    { ...update(), atUs: 3000001 },
    { ...update(), linkId: "0:99" },
    { ...update(), bufferCapacityPackets: 0 },
    { ...update(), queuedPackets: 1001 },
    { ...update(), queuedPackets: 0.5 },
    { ...update(), jitterMs: -1 },
    { ...update(), jitterMs: NaN },
    { ...update(), jitterMs: Infinity },
  ]) {
    assert.throws(() =>
      normalizeScenario({ ...scenario(), linkMetricUpdates: [bad] }),
    );
  }
  assert.throws(() =>
    normalizeScenario({
      ...scenario(),
      linkMetricUpdates: [update(), update()],
    }),
  );
  assert.throws(() => normalizeScenario({ ...legacy, schemaVersion: 3 }));
  assert.doesNotThrow(() =>
    normalizeScenario({
      ...scenario(),
      linkMetricUpdates: [{ ...update(), queuedPackets: 1000 }],
    }),
  );
});
test("initial and timed manual attributes change metrics without recalculating BFS", () => {
  const s = scenario();
  s.linkMetricUpdates = [
    update(),
    { ...update(500000), queuedPackets: 950, jitterMs: 5 },
  ];
  const e = new SimulationEngine(s),
    initial = e.result();
  assert.equal(initial.currentPathMetrics.candidate!.availableBufferRatio, 0.2);
  assert.equal(
    initial.installedEvaluation!.candidate!.availableBufferRatio,
    0.2,
  );
  e.advanceTo(499999);
  assert.equal(
    e.progress().currentPathMetrics.candidate!.availableBufferRatio,
    0.2,
  );
  e.advanceTo(500000);
  assert.equal(
    e.progress().currentPathMetrics.candidate!.availableBufferRatio,
    0.05,
  );
  assert.equal(e.progress().currentPathMetrics.candidate!.jitterMs, 5);
  assert.equal(
    e.result().installedEvaluation!.candidate!.availableBufferRatio,
    0.2,
  );
  assert.equal(e.result().installedEvaluation!.evaluatedUs, 0);
  assert.equal(e.result().currentPathMetrics.evaluatedUs, 500000);
  assert.equal(e.result().routingEvaluations.length, 1);
  assert.deepEqual(e.progress().path, initial.path);
  assert.deepEqual(e.drainDeltas(), []);
  const replay = new SimulationEngine(JSON.parse(JSON.stringify(s)));
  replay.advanceTo(500000);
  assert.deepEqual(e.result(), replay.result());
});
test("routing sees known state until detection; metric changes preserve recovery results", () => {
  const s = scenario();
  s.failures = [
    { atUs: SECOND, linkId: "0:1", down: true },
    { atUs: 2000000, linkId: "0:1", down: false },
  ];
  const baseline = new SimulationEngine(s);
  const seen: RoutingGraph[] = [];
  const strategy: RoutingStrategy = {
    name: "Injected BFS",
    calculate(graph, source, target) {
      seen.push(structuredClone(graph));
      return bfsStrategy.calculate(graph, source, target);
    },
  };
  const e = new SimulationEngine(
    {
      ...s,
      linkMetricUpdates: [
        update(SECOND),
        { ...update(2000000), queuedPackets: 100 },
      ],
    },
    strategy,
  );
  e.advanceTo(SECOND);
  assert.equal(
    e.graph().links.find((l) => l.id === "0:1")!.knownAvailable,
    true,
  );
  assert.equal(e.progress().currentPathMetrics.candidate, null);
  assert.ok(
    e
      .graph()
      .links.every((l) => !("physical" in l) && !("physicalAvailable" in l)),
  );
  e.advanceTo(1202000);
  assert.equal(
    seen.at(-1)!.links.find((l) => l.id === "0:1")!.knownAvailable,
    false,
  );
  assert.equal(e.result().installedEvaluation!.evaluatedUs, 1200000);
  e.advanceTo(s.durationUs);
  baseline.advanceTo(s.durationUs);
  for (const key of [
    "path",
    "serviceOutages",
    "linkFailures",
    "totalDowntimeUs",
    "availability",
  ] as const)
    assert.deepEqual(e.result()[key], baseline.result()[key]);
  assert.equal(e.result().serviceOutages[0].recoveryUs, 202000);
  assert.equal(
    e.graph().links.find((l) => l.id === "0:1")!.metrics.availableBufferRatio,
    0.9,
  );
  assert.equal(e.result().routingAlgorithm, "Injected BFS");
});
test("graph metrics use current logical geometry and caller mutations cannot alter the engine", () => {
  const s = {
    ...createScenario(
      { planes: 6, perPlane: 12, altitude: 550, inclination: 53, phase: 1 },
      DEFAULT_EPOCH_MS,
    ),
    durationUs: 3 * SECOND,
  };
  const e = new SimulationEngine(s),
    before = e.graph();
  before.links[0].metrics.availableBufferRatio = 0;
  assert.equal(e.graph().links[0].metrics.availableBufferRatio, 1);
  e.advanceTo(SECOND);
  assert.ok(
    e
      .graph()
      .links.some(
        (l, i) =>
          Math.abs(
            l.metrics.propagationDelayMs -
              before.links[i].metrics.propagationDelayMs,
          ) > 1e-8,
      ),
  );
});

test("manual metrics replay identically with stepping, pacing and event budgets", () => {
  const s = scenario();
  s.linkMetricUpdates = [
    update(),
    { ...update(SECOND), queuedPackets: 900 },
    { ...update(2000000), jitterMs: 4 },
  ];
  s.failures = [
    { atUs: SECOND, linkId: "0:1", down: true },
    { atUs: 2000000, linkId: "0:1", down: false },
  ];
  const baseline = new SimulationEngine(s);
  baseline.advanceTo(s.durationUs);
  for (const budget of [1, 500]) {
    const e = new SimulationEngine(s);
    for (let t = 50000; t <= s.durationUs; t += 50000)
      while (!e.advanceTo(t, budget)) e.drainDeltas();
    assert.deepEqual(e.result(), baseline.result());
  }
  const stepped = new SimulationEngine(s);
  while (stepped.nowUs < s.durationUs) stepped.step();
  assert.deepEqual(stepped.result(), baseline.result());
  const identity = new SimulationEngine({ ...s, target: 0 });
  assert.deepEqual(identity.progress().currentPathMetrics.candidate, {
    nodes: [0],
    propagationDelayMs: 0,
    availableBufferRatio: 1,
    jitterMs: 0,
  });
});
