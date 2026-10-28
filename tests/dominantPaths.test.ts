import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  findDominantPaths,
  DominantSearchError,
  bfsStrategy,
  analyseCandidates,
} from "../src/routing.ts";
import type {
  RoutingGraph,
  PathCandidate,
  DominantSearchSummary,
  RoutingStrategy,
} from "../src/routing.ts";
import {
  SimulationEngine,
  createScenario,
  DEFAULT_EPOCH_MS,
  normalizeScenario,
} from "../src/engine.ts";
import { TopologyStream } from "../src/topologyStream.ts";
const link = (a: number, b: number, d = 1, A = 1, J = 0) => ({
  id: `${a}:${b}`,
  sourceId: a,
  targetId: b,
  knownAvailable: true,
  metrics: { propagationDelayMs: d, availableBufferRatio: A, jitterMs: J },
});
function completeGraph(n: number): RoutingGraph {
  return {
    nodeCount: n,
    links: Array.from({ length: n }, (_, a) =>
      Array.from({ length: n - a - 1 }, (_, k) => link(a, a + k + 1, 0)),
    ).flat(),
  };
}
// Independent oracle enumerates paths first, then compares every completed pair.
function oracle(
  graph: RoutingGraph,
  source: number,
  target: number,
): PathCandidate[] {
  const queue: PathCandidate[] = [
      {
        nodes: [source],
        propagationDelayMs: 0,
        availableBufferRatio: 1,
        jitterMs: 0,
      },
    ],
    finished: PathCandidate[] = [];
  while (queue.length) {
    const p = queue.shift()!,
      last = p.nodes.at(-1)!;
    if (last === target) {
      finished.push(p);
      continue;
    }
    for (const l of graph.links) {
      if (!l.knownAvailable) continue;
      const next =
        l.sourceId === last
          ? l.targetId
          : l.targetId === last
            ? l.sourceId
            : -1;
      if (next < 0 || p.nodes.includes(next)) continue;
      queue.push({
        nodes: [...p.nodes, next],
        propagationDelayMs: p.propagationDelayMs + l.metrics.propagationDelayMs,
        availableBufferRatio: Math.min(
          p.availableBufferRatio,
          l.metrics.availableBufferRatio,
        ),
        jitterMs: Math.max(p.jitterMs, l.metrics.jitterMs),
      });
    }
  }
  return finished
    .filter(
      (p) =>
        !finished.some(
          (q) =>
            q !== p &&
            q.propagationDelayMs <= p.propagationDelayMs &&
            q.availableBufferRatio >= p.availableBufferRatio &&
            q.jitterMs <= p.jitterMs &&
            (q.propagationDelayMs < p.propagationDelayMs ||
              q.availableBufferRatio > p.availableBufferRatio ||
              q.jitterMs < p.jitterMs),
        ),
    )
    .sort((a, b) => (a.nodes.join(":") < b.nodes.join(":") ? -1 : 1));
}
test("exact frontier equals independent oracle across weighted graphs and link order", () => {
  let seed = 37;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let sample = 0; sample < 40; sample++) {
    const graph: RoutingGraph = { nodeCount: 6, links: [] };
    for (let a = 0; a < 6; a++)
      for (let b = a + 1; b < 6; b++)
        if (random() < 0.6)
          graph.links.push({
            ...link(
              a,
              b,
              Math.floor(random() * 5),
              Math.floor(random() * 5) / 4,
              Math.floor(random() * 17),
            ),
            knownAvailable: random() > 0.15,
          });
    const expected = oracle(graph, 0, 5);
    let summary: DominantSearchSummary | undefined;
    assert.deepEqual(
      findDominantPaths(graph, 0, 5, (s) => (summary = s)),
      expected,
    );
    assert.deepEqual(
      findDominantPaths({ ...graph, links: [...graph.links].reverse() }, 0, 5),
      expected,
    );
    assert.equal(summary!.complete, true);
    assert.equal(summary!.frontierSize, expected.length);
    assert.equal(
      summary!.completedPaths - summary!.removedPaths,
      expected.length,
    );
    assert.ok(summary!.prunedSamples.length <= 20);
  }
});
test("distinct equal tuples are retained, no cycles occur, identity and absence are explicit", () => {
  const g = completeGraph(5);
  assert.deepEqual(findDominantPaths(g, 0, 4), oracle(g, 0, 4));
  assert.equal(findDominantPaths(g, 0, 4).length, 16);
  for (const p of findDominantPaths(g, 0, 4))
    assert.equal(new Set(p.nodes).size, p.nodes.length);
  assert.deepEqual(findDominantPaths(g, 0, 0), [
    { nodes: [0], propagationDelayMs: 0, availableBufferRatio: 1, jitterMs: 0 },
  ]);
  assert.deepEqual(findDominantPaths({ nodeCount: 2, links: [] }, 0, 1), []);
});
test("search is service independent; later HR selection applies its strict threshold", () => {
  const g: RoutingGraph = {
    nodeCount: 4,
    links: [
      link(0, 1, 1, 0.5, 15),
      link(1, 3, 1, 0.5, 0),
      link(0, 2, 2, 0.9, 14.999),
      link(2, 3, 2, 0.9, 0),
    ],
  };
  const paths = findDominantPaths(g, 0, 3);
  assert.equal(paths.length, 2);
  assert.deepEqual(analyseCandidates(paths, "LS").selected!.nodes, [0, 1, 3]);
  assert.deepEqual(analyseCandidates(paths, "TS").selected!.nodes, [0, 2, 3]);
  assert.deepEqual(analyseCandidates(paths, "HR").selected!.nodes, [0, 2, 3]);
});
test("dominated paths carry bounded removal evidence including replaced frontier entries", () => {
  const g: RoutingGraph = {
    nodeCount: 4,
    links: [
      link(0, 1, 10, 0.2, 5),
      link(1, 3, 10, 0.2, 5),
      link(0, 2, 1, 0.9, 1),
      link(2, 3, 1, 0.9, 1),
    ],
  };
  let summary: DominantSearchSummary | undefined;
  const paths = findDominantPaths(g, 0, 3, (s) => (summary = s));
  assert.deepEqual(
    paths.map((p) => p.nodes),
    [[0, 2, 3]],
  );
  assert.equal(summary!.removedPaths, 1);
  assert.deepEqual(summary!.prunedSamples[0].candidate.nodes, [0, 1, 3]);
  assert.equal(summary!.prunedSamples[0].dominatedBy, "0:2:3");
});
test("node, expansion and frontier limits reject the whole search without success report", () => {
  const cases: [RoutingGraph, number, string][] = [
    [{ nodeCount: 17, links: [] }, 1, "node-limit"],
    [{ nodeCount: 10, links: completeGraph(9).links }, 9, "expansion-limit"],
    [completeGraph(9), 8, "candidate-limit"],
  ];
  for (const [graph, target, code] of cases) {
    let reported = false;
    assert.throws(
      () =>
        findDominantPaths(graph, 0, target, () => {
          reported = true;
        }),
      (e: unknown) =>
        e instanceof DominantSearchError &&
        e.code === code &&
        !e.search.complete,
    );
    assert.equal(reported, false);
  }
  assert.throws(
    () => findDominantPaths({ nodeCount: 2, links: [link(0, 1, -1)] }, 0, 1),
    /잘못/,
  );
  assert.throws(
    () =>
      findDominantPaths(
        { nodeCount: 2, links: [link(0, 1), link(1, 0)] },
        0,
        1,
      ),
    /중복/,
  );
});
test("automatic scenario recomputes attributes, uses completed spares and recalculates after exhaustion", () => {
  const s = normalizeScenario(
    JSON.parse(readFileSync("examples/dominant-routing.json", "utf8")),
  );
  const e = new SimulationEngine(s),
    stream = new TopologyStream();
  stream.reset(e.checkpoint());
  assert.equal(e.result().routingAnalyses[0].search!.frontierSize, 2);
  e.advanceTo(600000);
  stream.receive(e.drainDeltas());
  assert.equal(stream.at(499999)!.analysis.id, 1);
  assert.equal(stream.at(500000)!.analysis.search!.complete, true);
  assert.deepEqual(e.result().path, [0, 7, 6, 5, 4, 3]);
  e.advanceTo(1500000);
  assert.deepEqual(e.result().path, [0, 1, 2, 3]);
  assert.equal(e.result().routingEvaluations.length, 2);
  assert.equal(e.result().routingAnalyses.at(-1)!.mode, "reserve");
  assert.equal(e.result().routingAnalyses.at(-1)!.search, undefined);
  e.advanceTo(s.durationUs);
  assert.equal(e.result().routingEvaluations.length, 3);
  assert.equal(e.result().routingAnalyses.at(-1)!.search!.frontierSize, 0);
  assert.equal(e.result().unrecoveredCount, 1);
  assert.equal(e.result().serviceOutages[0].recoveryUs, 211000);
  assert.equal(e.result().validForAnalysis, true);
  for (const budget of [1, 500]) {
    const replay = new SimulationEngine(JSON.parse(JSON.stringify(s)));
    while (!replay.advanceTo(s.durationUs, budget)) replay.drainDeltas();
    assert.deepEqual(replay.result(), e.result());
  }
});
test("attribute changes during automatic computation invalidate old work", () => {
  const s = normalizeScenario(
    JSON.parse(readFileSync("examples/dominant-routing.json", "utf8")),
  );
  s.linkMetricUpdates.push({
    atUs: 505000,
    linkId: "0:7",
    bufferCapacityPackets: 1000,
    queuedPackets: 990,
    jitterMs: 1,
  });
  const e = new SimulationEngine(s);
  e.advanceTo(520000);
  assert.ok(e.result().events.some((v) => v.type === "route-discarded"));
  assert.equal(e.result().installedEvaluation!.evaluatedUs, 505000);
  assert.deepEqual(e.result().path, [0, 1, 2, 3]);
});
test("failed calculation at endpoint cannot be exported as a successful experiment or resumed", () => {
  const s = {
    ...createScenario(
      { planes: 1, perPlane: 8, altitude: 2000, inclination: 0, phase: 0 },
      DEFAULT_EPOCH_MS,
      0,
      3,
    ),
    durationUs: 1000000,
  };
  s.linkMetricUpdates = [
    {
      atUs: 1000000,
      linkId: "0:1",
      bufferCapacityPackets: 1000,
      queuedPackets: 100,
      jitterMs: 0,
    },
  ];
  let calls = 0;
  const strategy: RoutingStrategy = {
    name: "failure probe",
    calculate(g, source, target) {
      if (++calls > 1) return findDominantPaths(completeGraph(9), 0, 8);
      return bfsStrategy.calculate(g, source, target);
    },
  };
  const e = new SimulationEngine(s, strategy);
  assert.throws(() => e.advanceTo(s.durationUs), DominantSearchError);
  const r = e.result();
  assert.equal(r.completed, false);
  assert.equal(r.validForAnalysis, false);
  assert.equal(r.failure!.code, "candidate-limit");
  assert.equal(r.routingEvaluations.length, 1);
  assert.equal(e.progress().failure!.search!.complete, false);
  assert.ok(r.events.some((v) => v.type === "routing-search-aborted"));
  assert.throws(() => e.step());
  assert.throws(() => e.advanceTo(s.durationUs));
});
test("v5 supports automatic routing only up to 16 nodes and migrates v4 parameters unchanged", () => {
  const s = normalizeScenario(
    JSON.parse(readFileSync("examples/dominant-routing.json", "utf8")),
  );
  const migrated = normalizeScenario({ ...s, schemaVersion: 4 });
  assert.deepEqual(migrated, s);
  assert.throws(
    () =>
      normalizeScenario({
        ...s,
        config: { ...s.config, planes: 3, perPlane: 8 },
      }),
    /16기/,
  );
  assert.doesNotThrow(() =>
    normalizeScenario({
      ...s,
      config: { ...s.config, planes: 2, perPlane: 8 },
    }),
  );
});

test("16-node boundary succeeds and incomplete strategy reports are rejected", () => {
  const line: RoutingGraph = {
    nodeCount: 16,
    links: Array.from({ length: 15 }, (_, i) => link(i, i + 1)),
  };
  assert.deepEqual(findDominantPaths(line, 0, 15), [
    {
      nodes: Array.from({ length: 16 }, (_, i) => i),
      propagationDelayMs: 15,
      availableBufferRatio: 1,
      jitterMs: 0,
    },
  ]);
  const scenario = createScenario(
    { planes: 1, perPlane: 8, altitude: 2000, inclination: 0, phase: 0 },
    DEFAULT_EPOCH_MS,
    0,
    3,
  );
  const strategy: RoutingStrategy = {
    name: "incomplete probe",
    calculate(g, s, t, report) {
      report?.({
        complete: false,
        expandedStates: 1,
        completedPaths: 1,
        frontierSize: 1,
        removedPaths: 0,
        prunedSamples: [],
      });
      return bfsStrategy.calculate(g, s, t);
    },
  };
  assert.throws(
    () => new SimulationEngine(scenario, strategy),
    /완료되지 않은/,
  );
});
