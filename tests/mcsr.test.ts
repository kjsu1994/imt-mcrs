import { test } from "node:test";
import { TopologyStream } from "../src/topologyStream.ts";
import assert from "node:assert/strict";
import { McsrController, partitionSrds } from "../src/mcsr.ts";
import { findDominantPaths, analyseCandidates } from "../src/routing.ts";
import type { RoutingGraph } from "../src/routing.ts";
import {
  createScenario,
  SimulationEngine,
  DEFAULT_EPOCH_MS,
  normalizeScenario,
} from "../src/engine.ts";
const link = (a: number, b: number, d = 1, A = 1, J = 0) => ({
  id: `${a}:${b}`,
  sourceId: a,
  targetId: b,
  knownAvailable: true,
  metrics: { propagationDelayMs: d, availableBufferRatio: A, jitterMs: J },
});
const config = {
  planes: 2,
  perPlane: 8,
  altitude: 2000,
  inclination: 90,
  phase: 0,
};
function scenario() {
  const s = createScenario(config, DEFAULT_EPOCH_MS, 0, 12);
  s.routing.algorithm = "mcsr";
  s.srd = { planesPerDomain: 1, satellitesPerDomain: 4 };
  s.durationUs = 4000000;
  s.notificationDelayUs = 10000;
  return s;
}
test("balanced tail membership and fixed DS use structural boundary links", () => {
  const p = partitionSrds(
    { planes: 3, perPlane: 5 },
    { planesPerDomain: 2, satellitesPerDomain: 3 },
    [link(2, 3), link(5, 10)],
  );
  assert.deepEqual(
    p.domains.map((d) => d.nodes),
    [
      [0, 1, 2, 5, 6, 7],
      [3, 4, 8, 9],
      [10, 11, 12],
      [13, 14],
    ],
  );
  assert.deepEqual(
    p.domains.map((d) => d.ds),
    [7, 9, 12, 14],
  );
  assert.deepEqual(p.domains[0].boundaryNodes, [2, 5]);
  assert.throws(() =>
    partitionSrds(config, { planesPerDomain: 0, satellitesPerDomain: 4 }, []),
  );
});
test("hierarchical candidates equal the global frontier across weighted graphs and domain reentry", () => {
  for (let seed = 0; seed < 40; seed++) {
    const graph: RoutingGraph = { nodeCount: 8, links: [] };
    for (let a = 0; a < 8; a++)
      for (let b = a + 1; b < 8; b++)
        if ((a * 17 + b * 13 + seed * 7) % 5 < 2)
          graph.links.push(
            link(
              a,
              b,
              1 + ((a + b + seed) % 4),
              0.3 + ((a * 3 + b + seed) % 7) / 10,
              (a + b + seed) % 6,
            ),
          );
    const c = new McsrController(
      { planes: 2, perPlane: 4 },
      { planesPerDomain: 1, satellitesPerDomain: 2 },
      graph,
      0,
    );
    assert.deepEqual(c.calculate(0, 7), findDominantPaths(graph, 0, 7));
    assert.equal(c.lastAnalysis?.comparison?.matched, true);
  }
  const graph = { nodeCount: 4, links: [link(0, 2), link(2, 1), link(1, 3)] };
  const c = new McsrController(
    { planes: 1, perPlane: 4 },
    { planesPerDomain: 1, satellitesPerDomain: 2 },
    graph,
    0,
  );
  assert.deepEqual(c.calculate(0, 3)[0].nodes, [0, 2, 1, 3]);
  assert.deepEqual(c.lastAnalysis?.segments[0].domains, [0, 1, 0, 1]);
});
test("internal cost, equal metric spares, identity and absent paths are preserved", () => {
  const graph = {
    nodeCount: 6,
    links: [
      link(0, 1, 8),
      link(1, 3),
      link(0, 2),
      link(2, 4),
      link(3, 5),
      link(4, 5),
    ],
  };
  const c = new McsrController(
    { planes: 2, perPlane: 3 },
    { planesPerDomain: 1, satellitesPerDomain: 3 },
    graph,
    0,
  );
  assert.deepEqual(c.calculate(0, 5)[0].nodes, [0, 2, 4, 5]);
  graph.links[0].metrics.propagationDelayMs = 1;
  const equal = new McsrController(
    { planes: 2, perPlane: 3 },
    { planesPerDomain: 1, satellitesPerDomain: 3 },
    graph,
    0,
  );
  assert.equal(equal.calculate(0, 5).length, 2);
  assert.deepEqual(equal.calculate(0, 0)[0].nodes, [0]);
  const empty = new McsrController(
    { planes: 2, perPlane: 3 },
    { planesPerDomain: 1, satellitesPerDomain: 3 },
    { ...graph, links: [] },
    0,
  );
  assert.deepEqual(empty.calculate(0, 5), []);
});
test("remote state is unavailable before receipt and older messages cannot overwrite CSIB", () => {
  const graph = {
    nodeCount: 8,
    links: Array.from({ length: 7 }, (_, i) => link(i, i + 1)),
  };
  const c = new McsrController(
    { planes: 1, perPlane: 8 },
    { planesPerDomain: 1, satellitesPerDomain: 4 },
    graph,
    0,
  );
  const before = c.inputKey();
  graph.links[5].knownAvailable = false;
  const [old] = c.update(graph, 100);
  assert.equal(old.domainId, 1);
  assert.equal(c.inputKey(), before);
  assert.equal(c.calculate(0, 7).length, 1);
  assert.equal(c.lastAnalysis?.synchronized, false);
  graph.links[5].knownAvailable = true;
  const [newer] = c.update(graph, 200);
  c.receive(newer, 0, 210);
  assert.equal(c.receive(old, 0, 220), false);
  assert.equal(c.calculate(0, 7).length, 1);
  assert.equal(c.view().domains[0].receivedVersions[1], 2);
});
test("unreachable remote updates do not invalidate the source input", () => {
  const graph = { nodeCount: 8, links: [link(0, 1), link(4, 5), link(5, 6)] };
  const c = new McsrController(
    { planes: 1, perPlane: 8 },
    { planesPerDomain: 1, satellitesPerDomain: 4 },
    graph,
    0,
  );
  const before = c.inputKey();
  graph.links[1].metrics.availableBufferRatio = 0.1;
  for (const ad of c.update(graph, 100)) c.receive(ad, 0, 110);
  assert.equal(c.inputKey(), before);
});
test("MCSR engine cached recovery, CSIB trace and replay are deterministic", () => {
  const s = scenario(),
    initial = new SimulationEngine(s);
  const path = initial.result().path;
  assert.ok(path.length > 1);
  s.failures = [
    {
      atUs: 1000000,
      linkId: `${Math.min(path[0], path[1])}:${Math.max(path[0], path[1])}`,
      down: true,
    },
  ];
  const direct = new SimulationEngine(s);
  direct.advanceTo(s.durationUs);
  const stepped = new SimulationEngine(s);
  while (stepped.nowUs < s.durationUs) stepped.step();
  assert.deepEqual(direct.result(), stepped.result());
  assert.equal(direct.result().validForAnalysis, true);
  assert.ok(direct.result().routingAnalyses.some((a) => a.mode === "reserve"));
  assert.ok(
    direct.result().mcsr?.events.some((e) => e.type === "csib-received"),
  );
  assert.ok(direct.result().routingAnalyses[0].mcsr?.comparison?.matched);
  assert.ok(
    direct
      .result()
      .routingAnalyses.every((a) =>
        a.candidates.every((c) => new Set(c.nodes).size === c.nodes.length),
      ),
  );
});
test("v5 migration preserves routing; v6 rejects absent SRD and unsupported scale", () => {
  const s = scenario();
  const { srd, ...old } = s;
  assert.equal(
    normalizeScenario({ ...old, schemaVersion: 5 }).routing.algorithm,
    "mcsr",
  );
  assert.throws(() => normalizeScenario(old));
  assert.throws(
    () => new SimulationEngine({ ...s, config: { ...config, planes: 3 } }),
    /16/,
  );
});

test("remote metric updates wait for CSIB and supersede an in-flight calculation", () => {
  const s = scenario();
  s.routing.service = "TS";
  s.linkMetricUpdates = [
    {
      atUs: 500000,
      linkId: "10:11",
      bufferCapacityPackets: 1000,
      queuedPackets: 900,
      jitterMs: 0,
    },
  ];
  const e = new SimulationEngine(s);
  const direct = e.result().path.join(":");
  e.advanceTo(500000);
  assert.equal(
    e.graph().links.find((l) => l.id === "10:11")!.metrics.availableBufferRatio,
    1,
  );
  assert.equal(e.result().routingAnalyses.length, 1);
  e.advanceTo(509999);
  assert.equal(e.result().path.join(":"), direct);
  e.advanceTo(512000);
  assert.notEqual(e.result().path.join(":"), direct);
  assert.equal(e.result().routingAnalyses.at(-1)!.atUs, 510000);
  const stale = scenario();
  stale.routing.service = "TS";
  stale.computeDelayUs = 100000;
  stale.linkMetricUpdates = [
    {
      atUs: 500000,
      linkId: "0:1",
      bufferCapacityPackets: 1000,
      queuedPackets: 900,
      jitterMs: 0,
    },
    {
      atUs: 501000,
      linkId: "10:11",
      bufferCapacityPackets: 1000,
      queuedPackets: 800,
      jitterMs: 0,
    },
  ];
  const engine = new SimulationEngine(stale);
  engine.advanceTo(700000);
  assert.ok(
    engine.result().routingAnalyses.some((a) => a.status === "discarded"),
  );
  assert.equal(engine.result().routingAnalyses.at(-1)!.status, "installed");
});
test("internal, internal-boundary, boundary and cross-domain failures update their owner domains", () => {
  const links = Array.from({ length: 15 }, (_, i) => link(i, i + 1));
  links.push(link(0, 15), link(0, 7));
  for (const id of ["2:3", "0:1", "0:7", "7:8"]) {
    const graph = { nodeCount: 16, links: structuredClone(links) };
    const c = new McsrController(
      { planes: 1, perPlane: 16 },
      { planesPerDomain: 1, satellitesPerDomain: 8 },
      graph,
      0,
    );
    graph.links.find((l) => l.id === id)!.knownAvailable = false;
    assert.deepEqual(
      c.update(graph, 100).map((a) => a.domainId),
      id === "7:8" ? [0, 1] : [0],
    );
  }
});
test("MCSR guards abort without returning or reporting a partial frontier", () => {
  const graph = { nodeCount: 9, links: [] as ReturnType<typeof link>[] };
  for (let a = 0; a < 9; a++)
    for (let b = a + 1; b < 9; b++) graph.links.push(link(a, b, 0));
  const c = new McsrController(
    { planes: 1, perPlane: 9 },
    { planesPerDomain: 1, satellitesPerDomain: 1 },
    graph,
    0,
  );
  let reported = false;
  assert.throws(
    () =>
      c.calculate(0, 8, () => {
        reported = true;
      }),
    (error: any) =>
      error.code === "candidate-limit" &&
      error.search.complete === false &&
      error.search.frontierSize === 2048,
  );
  assert.equal(reported, false);
  assert.throws(
    () =>
      new McsrController(
        { planes: 1, perPlane: 9 },
        { planesPerDomain: 1, satellitesPerDomain: 9 },
        graph,
        0,
      ),
    (error: any) => error.code === "expansion-limit",
  );
});
test("a local crossing observation wins over a same-time remote report", () => {
  const graph = { nodeCount: 4, links: [link(0, 1), link(1, 2), link(2, 3)] };
  const c = new McsrController(
    { planes: 1, perPlane: 4 },
    { planesPerDomain: 1, satellitesPerDomain: 2 },
    graph,
    3,
  );
  graph.links[0].metrics.availableBufferRatio = 0.8;
  const [old] = c.update(graph, 100);
  c.receive(old, 1, 100);
  graph.links[1].knownAvailable = false;
  c.update(graph, 100);
  assert.equal(
    c.graph().links.find((l) => l.id === "1:2")!.knownAvailable,
    false,
  );
});

test("MCSR CSIB revisions and route changes apply only at their displayed time", () => {
  const s = scenario();
  s.routing.service = "TS";
  s.linkMetricUpdates = [
    {
      atUs: 500000,
      linkId: "10:11",
      bufferCapacityPackets: 1000,
      queuedPackets: 900,
      jitterMs: 0,
    },
  ];
  const e = new SimulationEngine(s),
    stream = new TopologyStream();
  stream.reset(e.checkpoint());
  e.advanceTo(512000);
  stream.receive(e.drainDeltas());
  assert.ok(stream.matches(e.checkpoint()));
  assert.equal(stream.at(499999)!.mcsr!.domains[2].revision, 0);
  assert.equal(stream.at(500000)!.mcsr!.domains[2].revision, 1);
  assert.equal(stream.at(500000)!.mcsr!.domains[0].receivedVersions[2], 0);
  assert.equal(stream.at(510000)!.mcsr!.domains[0].receivedVersions[2], 1);
  assert.deepEqual(stream.at(512000)!.path, e.result().path);
  const p = partitionSrds(
    { planes: 4, perPlane: 4 },
    { planesPerDomain: 2, satellitesPerDomain: 2 },
    [],
  );
  assert.deepEqual(
    p.domains.map((d) => d.nodes),
    [
      [0, 1, 4, 5],
      [2, 3, 6, 7],
      [8, 9, 12, 13],
      [10, 11, 14, 15],
    ],
  );
});

test("runtime comparison uses the independent observed graph, not a corrupted CSIB reconstruction", () => {
  const graph = { nodeCount: 4, links: [link(0, 1), link(1, 2), link(2, 3)] };
  const c = new McsrController(
    { planes: 1, perPlane: 4 },
    { planesPerDomain: 1, satellitesPerDomain: 2 },
    graph,
    0,
  );
  // Deliberate fault injection proves that the comparison cannot validate its own missing topology.
  (c as any).csibs[0][1].segments = [];
  assert.throws(() => c.calculate(0, 3), /frontier mismatch/);
});
