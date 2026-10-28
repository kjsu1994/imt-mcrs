import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SimulationEngine,
  createScenario,
  normalizeScenario,
  DEFAULT_EPOCH_MS,
} from "../src/engine.ts";
import {
  analyseCandidates,
  bfsStrategy,
  evaluatePath,
  validateCandidates,
} from "../src/routing.ts";
import type { PathCandidate, RoutingStrategy } from "../src/routing.ts";
import { TopologyStream } from "../src/topologyStream.ts";
const direct = [0, 1, 2, 3],
  spare = [0, 7, 6, 5, 4, 3];
function scenario() {
  return {
    ...createScenario(
      { planes: 1, perPlane: 8, altitude: 2000, inclination: 0, phase: 0 },
      DEFAULT_EPOCH_MS,
      0,
      3,
    ),
    durationUs: 3000000,
  };
}
function candidates() {
  const s = scenario();
  s.routing = {
    algorithm: "candidate-paths",
    service: "LS",
    candidatePaths: [direct, spare],
  };
  return s;
}
function metric(
  atUs: number,
  linkId: string,
  queuedPackets: number,
  jitterMs = 0,
) {
  return { atUs, linkId, bufferCapacityPackets: 1000, queuedPackets, jitterMs };
}

test("strategy boundary rejects bad endpoints, range, loops, missing links and metric lies", () => {
  const s = scenario(),
    graph = new SimulationEngine(s).graph();
  for (const nodes of [
    [0],
    [1, 2, 3],
    [0, 1, 2],
    [0, 99, 3],
    [0, 1.5, 3],
    [0, 1, 0, 1, 2, 3],
    [0, 3],
  ]) {
    const strategy: RoutingStrategy = {
      name: "bad path",
      calculate() {
        return [
          {
            nodes,
            propagationDelayMs: 0,
            availableBufferRatio: 1,
            jitterMs: 0,
          },
        ];
      },
    };
    assert.throws(
      () => new SimulationEngine(s, strategy),
      /Invalid routing candidate/,
    );
  }
  const actual = evaluatePath(direct, graph.links)!;
  for (const changed of [
    { propagationDelayMs: 123 },
    { availableBufferRatio: NaN },
    { jitterMs: -1 },
    { availableBufferRatio: 1.01 },
  ]) {
    assert.throws(
      () =>
        new SimulationEngine(s, {
          name: "bad metrics",
          calculate() {
            return [{ ...actual, ...changed }];
          },
        }),
      /metric-mismatch/,
    );
  }
  assert.equal(
    validateCandidates([actual, structuredClone(actual)], graph, 0, 3).length,
    1,
  );
  assert.throws(
    () =>
      new SimulationEngine(s, {
        name: "mutating",
        calculate(g) {
          g.links.forEach((l) => (l.metrics.propagationDelayMs = 0));
          return bfsStrategy.calculate(g, 0, 3);
        },
      }),
    /metric-mismatch/,
  );
});
test("selection explains dominance, retains distinct equal tuples and enforces strict HR boundary", () => {
  const a: PathCandidate = {
    nodes: [0, 1, 3],
    propagationDelayMs: 10,
    availableBufferRatio: 0.7,
    jitterMs: 2,
  };
  const b: PathCandidate = {
    nodes: [0, 2, 3],
    propagationDelayMs: 15,
    availableBufferRatio: 0.9,
    jitterMs: 1,
  };
  const c: PathCandidate = {
    nodes: [0, 4, 3],
    propagationDelayMs: 20,
    availableBufferRatio: 0.5,
    jitterMs: 4,
  };
  assert.deepEqual(analyseCandidates([c, b, a], "LS").selected, a);
  assert.deepEqual(analyseCandidates([c, b, a], "TS").selected, b);
  assert.equal(
    analyseCandidates([c, b, a], "LS").decisions.find((x) => x.id === "0:4:3")!
      .status,
    "dominated",
  );
  const equal = { ...a, nodes: [0, 5, 3] };
  assert.equal(
    analyseCandidates([a, equal], "LS").decisions.filter(
      (x) => x.status === "eligible",
    ).length,
    1,
  );
  assert.equal(
    analyseCandidates([{ ...a, jitterMs: 15 }], "HR").selected,
    null,
  );
  assert.ok(analyseCandidates([{ ...a, jitterMs: 14.999 }], "HR").selected);
  assert.equal(
    analyseCandidates([{ ...a, jitterMs: 15 }], "HR").decisions[0].status,
    "jitter-limit",
  );
});
test("attribute-only change reroutes configured candidates and stale computations cannot install", () => {
  const s = candidates();
  s.routing.service = "TS";
  s.linkMetricUpdates = [
    metric(0, "0:1", 100),
    metric(0, "0:7", 300),
    metric(500000, "0:1", 900),
    metric(500500, "0:7", 950),
  ];
  const e = new SimulationEngine(s);
  e.advanceTo(500000);
  assert.equal(e.progress().routingAnalysis.status, "pending");
  assert.deepEqual(e.result().path, direct);
  e.advanceTo(501000);
  assert.ok(
    e
      .result()
      .events.some((x) => x.type === "route-discarded" && x.atUs === 501000),
  );
  assert.equal(e.result().routingAnalyses[1].status, "discarded");
  e.advanceTo(502500);
  assert.deepEqual(e.result().path, direct);
  assert.equal(e.result().installedEvaluation!.evaluatedUs, 500500);
  assert.equal(e.progress().routingAnalysis.status, "installed");
  assert.equal(e.result().routingEvaluations.length, 3);
});
test("cached spare switches without recomputation and stages have separate configured times", () => {
  const s = candidates();
  s.notificationDelayUs = 10000;
  s.switchDelayUs = 5000;
  s.computeDelayUs = 50000;
  s.installDelayUs = 2000;
  s.failures = [{ atUs: 1000000, linkId: "0:1", down: true }];
  const e = new SimulationEngine(s);
  e.advanceTo(1200000);
  assert.equal(
    e.graph().links.find((l) => l.id === "0:1")!.knownAvailable,
    true,
  );
  e.advanceTo(1210000);
  assert.equal(
    e.graph().links.find((l) => l.id === "0:1")!.knownAvailable,
    false,
  );
  e.advanceTo(s.durationUs);
  assert.deepEqual(e.result().path, spare);
  assert.equal(e.result().routingEvaluations.length, 1);
  assert.equal(e.result().serviceOutages[0].recoveryUs, 217000);
  const events = e.result().events;
  assert.ok(
    events.some(
      (x) => x.type === "reserve-switch-started" && x.atUs === 1210000,
    ),
  );
  assert.ok(
    events.some((x) => x.type === "reserve-switch-ready" && x.atUs === 1215000),
  );
  assert.ok(
    events.some(
      (x) => x.type === "route-install-started" && x.atUs === 1215000,
    ),
  );
  assert.ok(
    events.some((x) => x.type === "route-installed" && x.atUs === 1217000),
  );
  assert.equal(
    e
      .result()
      .routingAnalyses[1].candidates.find((c) => c.id === direct.join(":"))!
      .status,
    "unavailable",
  );
  const baseline = new SimulationEngine({
    ...s,
    routing: { ...s.routing, algorithm: "bfs" },
  });
  baseline.advanceTo(s.durationUs);
  assert.equal(baseline.result().serviceOutages[0].recoveryUs, 262000);
});
test("no spare triggers exactly one calculation after simultaneous failures", () => {
  const s = candidates();
  s.failures = [
    { atUs: 1000000, linkId: "0:1", down: true },
    { atUs: 1000000, linkId: "0:7", down: true },
  ];
  const e = new SimulationEngine(s);
  e.advanceTo(s.durationUs);
  assert.equal(e.result().routingEvaluations.length, 2);
  assert.deepEqual(e.result().path, []);
  assert.equal(e.result().serviceOutages[0].status, "unrecovered");
  assert.equal(e.result().routingAnalyses.at(-1)!.mode, "recalculate");
});
test("a second failure invalidates an in-flight spare installation", () => {
  const s = candidates();
  s.installDelayUs = 500000;
  s.failures = [
    { atUs: 1000000, linkId: "0:1", down: true },
    { atUs: 1100000, linkId: "0:7", down: true },
  ];
  const e = new SimulationEngine(s);
  e.advanceTo(s.durationUs);
  assert.ok(
    e
      .result()
      .events.some((x) => x.type === "route-discarded" && x.mode === "reserve"),
  );
  assert.equal(e.result().recoveredCount, 0);
  assert.equal(e.result().serviceOutages[0].recoveredUs, null);
});
test("delayed notification is cancelled if physical state changes before delivery", () => {
  const s = scenario();
  s.notificationDelayUs = 100000;
  s.failures = [
    { atUs: 1000000, linkId: "0:1", down: true },
    { atUs: 1250000, linkId: "0:1", down: false },
  ];
  const e = new SimulationEngine(s);
  e.advanceTo(s.durationUs);
  assert.equal(e.result().routingEvaluations.length, 1);
  assert.ok(e.result().events.some((x) => x.type === "notification-discarded"));
  assert.equal(e.result().serviceOutages[0].recoveredUs, 1250000);
});
test("configured routing, decisions and phases replay identically across batches and display time", () => {
  const s = candidates();
  s.routing.service = "TS";
  s.linkMetricUpdates = [
    metric(0, "0:1", 100),
    metric(0, "0:7", 300),
    metric(500000, "0:1", 900),
  ];
  s.failures = [{ atUs: 1000000, linkId: "0:7", down: true }];
  const e = new SimulationEngine(s),
    stream = new TopologyStream();
  stream.reset(e.checkpoint());
  e.advanceTo(600000);
  stream.receive(e.drainDeltas());
  assert.equal(stream.at(499999)!.analysis.id, 1);
  assert.equal(stream.at(500000)!.analysis.status, "pending");
  assert.equal(stream.at(502000)!.analysis.status, "installed");
  assert.equal(stream.matches(e.checkpoint()), true);
  e.advanceTo(s.durationUs);
  for (const budget of [1, 500]) {
    const replay = new SimulationEngine(JSON.parse(JSON.stringify(s)));
    while (!replay.advanceTo(s.durationUs, budget)) replay.drainDeltas();
    assert.deepEqual(replay.result(), e.result());
  }
  const stepped = new SimulationEngine(s);
  while (stepped.nowUs < s.durationUs) stepped.step();
  assert.deepEqual(stepped.result(), e.result());
});
test("v4 routing configuration rejects unknown algorithms, invalid templates and delays", () => {
  for (const change of [
    { routing: { algorithm: "unknown", service: "LS", candidatePaths: [] } },
    { routing: { algorithm: "bfs", service: "unknown", candidatePaths: [] } },
    {
      routing: {
        algorithm: "candidate-paths",
        service: "LS",
        candidatePaths: [[0]],
      },
    },
    { notificationDelayUs: -1 },
    { switchDelayUs: Infinity },
  ])
    assert.throws(() => normalizeScenario({ ...scenario(), ...change }));
  for (const version of [undefined, 1, 2, 3]) {
    const {
      schemaVersion,
      routing,
      notificationDelayUs,
      switchDelayUs,
      ...old
    } = scenario();
    const migrated = normalizeScenario({
      ...old,
      ...(version === undefined ? {} : { schemaVersion: version }),
    });
    assert.equal(migrated.schemaVersion, 7);
    assert.equal(migrated.routing.algorithm, "bfs");
    assert.equal(migrated.switchDelayUs, 0);
  }
});

test("HR feasibility changes are evaluated even for a single BFS candidate", () => {
  const s = scenario();
  s.routing.service = "HR";
  s.linkMetricUpdates = [metric(500000, "0:1", 0, 15)];
  const e = new SimulationEngine(s);
  e.advanceTo(502000);
  assert.deepEqual(e.result().path, []);
  assert.equal(
    e.progress().routingAnalysis.candidates[0].status,
    "jitter-limit",
  );
});
