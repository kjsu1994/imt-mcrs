import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McsrController } from "../src/mcsr.ts";
import { searchDefaults } from "../src/boundedSearch.ts";
import {
  findDominantPaths,
  analyseCandidates,
  validateCandidates,
} from "../src/routing.ts";
import {
  createScenario,
  normalizeScenario,
  SimulationEngine,
  DEFAULT_EPOCH_MS,
  validateScenario,
} from "../src/engine.ts";
import { position, positions, PRESETS } from "../src/model.ts";
import { TopologyStream } from "../src/topologyStream.ts";
const link = (a: number, b: number, D = 1, A = 1, J = 0) => ({
  id: `${a}:${b}`,
  sourceId: a,
  targetId: b,
  knownAvailable: true,
  metrics: { propagationDelayMs: D, availableBufferRatio: A, jitterMs: J },
});
const example = () =>
  normalizeScenario(
    JSON.parse(readFileSync("examples/mcsr-routing.json", "utf8")),
  );
function finish(e: SimulationEngine, budget = 500) {
  while (!e.advanceTo(e.scenario.durationUs, budget)) e.drainDeltas();
  e.drainDeltas();
  return e.result();
}
test("bounded anchors preserve the three service choices on a small independently enumerated graph", () => {
  const graph = {
    nodeCount: 8,
    links: [
      link(0, 1, 1, 0.4, 2),
      link(1, 7, 1, 0.4, 2),
      link(0, 2, 2, 0.9, 20),
      link(2, 7, 2, 0.9, 20),
      link(0, 3, 3, 0.8, 1),
      link(3, 7, 3, 0.8, 1),
      link(0, 4, 1, 0.4, 2),
      link(4, 7, 1, 0.4, 2),
    ],
  };
  const c = new McsrController(
    { planes: 2, perPlane: 4 },
    { planesPerDomain: 1, satellitesPerDomain: 2 },
    graph,
    0,
    searchDefaults(8, "bounded"),
    7,
  );
  const candidates = c.calculate(0, 7),
    exact = findDominantPaths(graph, 0, 7);
  for (const service of ["LS", "TS", "HR"] as const)
    assert.deepEqual(
      analyseCandidates(candidates, service).selected,
      analyseCandidates(exact, service).selected,
    );
  assert.equal(c.lastAnalysis?.allCandidatesGuaranteed, false);
  assert.equal(c.lastAnalysis?.comparison, null);
  assert.equal(candidates.filter((p) => p.propagationDelayMs === 2).length, 2);
  validateCandidates(candidates, graph, 0, 7);
  assert.deepEqual(c.calculate(0, 0)[0].nodes, [0]);
});
test("all known links survive a sparse segment summary; a search miss is not reported as disconnection", () => {
  const graph = { nodeCount: 4, links: [link(0, 1), link(1, 2), link(2, 3)] };
  const c = new McsrController(
    { planes: 1, perPlane: 4 },
    { planesPerDomain: 1, satellitesPerDomain: 4 },
    graph,
    0,
    searchDefaults(4, "bounded"),
    3,
  );
  assert.equal(c.graph().links.length, 3);
  (c as any).csibs[0][0].segments = [];
  assert.throws(
    () => c.calculate(0, 3),
    (e: any) => e.code === "bounded-no-candidate",
  );
  const down = {
    nodeCount: 4,
    links: graph.links.map((l) => ({ ...l, knownAvailable: false })),
  };
  const empty = new McsrController(
    { planes: 1, perPlane: 4 },
    { planesPerDomain: 1, satellitesPerDomain: 4 },
    down,
    0,
    searchDefaults(4, "bounded"),
    3,
  );
  assert.deepEqual(empty.calculate(0, 3), []);
  assert.equal(empty.graph().links.length, 3);
  assert.throws(
    () =>
      new McsrController(
        { planes: 1, perPlane: 4 },
        { planesPerDomain: 1, satellitesPerDomain: 4 },
        { ...graph, links: [...graph.links, link(0, 1)] },
        0,
        searchDefaults(4, "bounded"),
        3,
      ),
    /중복/,
  );
});
test("v8 persists explicit bounds while v7 stays reference; invalid policies do not silently change modes", () => {
  const old = JSON.parse(readFileSync("examples/mcsr-routing.json", "utf8"));
  assert.equal(normalizeScenario(old).mcsrSearch.mode, "reference");
  for (const p of PRESETS) {
    const s = createScenario(p.config, DEFAULT_EPOCH_MS);
    s.routing.algorithm = "mcsr";
    validateScenario(s);
    assert.equal(normalizeScenario(s).mcsrSearch.mode, "bounded");
  }
  const s = example();
  assert.throws(() => normalizeScenario({ ...s, mcsrSearch: undefined }));
  for (const setting of [
    { ...s.mcsrSearch, mode: "other" },
    { ...s.mcsrSearch, expansionLimit: 0 },
    { ...s.mcsrSearch, traceLimit: 1 },
  ])
    assert.throws(() => normalizeScenario({ ...s, mcsrSearch: setting }));
  assert.throws(
    () =>
      normalizeScenario({
        ...createScenario(PRESETS[0].config, DEFAULT_EPOCH_MS),
        srd: { planesPerDomain: 6, satellitesPerDomain: 12 },
      }),
    /32/,
  );
});
test("cooperative initialization cannot export partial success and equals synchronous execution", () => {
  const s = createScenario(PRESETS[0].config, DEFAULT_EPOCH_MS, 0, 61);
  s.routing.algorithm = "mcsr";
  s.durationUs = 3000000;
  const sync = new SimulationEngine(s),
    deferred = new SimulationEngine(s, undefined, true);
  assert.equal(deferred.needsWork, true);
  assert.throws(() => deferred.result(), /완료/);
  assert.equal(deferred.advanceTo(s.durationUs, 1), false);
  assert.equal(deferred.nowUs, 0);
  const expected = finish(sync);
  assert.deepEqual(finish(deferred, 1), expected);
  const steps = new SimulationEngine(s);
  while (steps.nowUs < s.durationUs) {
    steps.step();
    steps.drainDeltas();
  }
  assert.deepEqual(steps.result(), expected);
});
test("bounded CSIB/control deltas reconstruct the checkpoint and retain timestamped rendering", () => {
  const s = example();
  s.mcsrSearch = searchDefaults(16, "bounded");
  s.durationUs = 3500000;
  const e = new SimulationEngine(s),
    stream = new TopologyStream();
  stream.reset(e.checkpoint());
  let hasDelta = false;
  while (e.nowUs < s.durationUs) {
    e.advanceTo(Math.min(s.durationUs, e.nowUs + 50000));
    const deltas = e.drainDeltas();
    hasDelta ||= deltas.some((d) => !!d.mcsrDelta);
    stream.receive(deltas);
    assert.ok(stream.matches(e.checkpoint()));
    stream.at(e.nowUs);
  }
  assert.ok(hasDelta);
  assert.equal(e.result().validForAnalysis, true);
  assert.ok(
    e.result().serviceOutages.some((o) => o.recoveryMechanism === "reserve"),
  );
});
test("bounded trace drops detail without dropping modeled control events; the processing guard still fails closed", () => {
  const s = example();
  s.mcsrSearch = {
    ...searchDefaults(16, "bounded"),
    traceLimit: 24,
    delayPublishIntervalUs: 1000000,
  };
  s.durationUs = 2000000;
  s.failures = s.failures.filter((f) => f.atUs <= s.durationUs);
  const e = new SimulationEngine(s);
  const r = finish(e),
    c = r.mcsr!.control!;
  assert.ok(c.traceOmitted! > 0);
  assert.equal(c.events.length + c.traceOmitted!, c.stats.eventCount);
  assert.ok(c.events.length <= 24);
  const bad = structuredClone(s);
  bad.mcsrSearch.controlEventLimit = 24;
  const failed = new SimulationEngine(bad);
  assert.throws(() => finish(failed), /한도/);
  assert.equal(failed.result().validForAnalysis, false);
});
test("bounded search budget exhaustion does not return a completed candidate set", () => {
  const s = createScenario(PRESETS[0].config, DEFAULT_EPOCH_MS, 0, 61);
  s.routing.algorithm = "mcsr";
  s.mcsrSearch.expansionLimit = 100;
  assert.throws(
    () => new SimulationEngine(s),
    (e: any) => e.code === "expansion-limit" && !e.search.complete,
  );
});
test("single-node control positions agree exactly with the renderer constellation", () => {
  const c = PRESETS[1].config,
    p = positions(c, 123.456, DEFAULT_EPOCH_MS);
  for (const id of [0, 41, 777, 1583])
    assert.deepEqual(position(c, id, 123.456, DEFAULT_EPOCH_MS), p[id]);
});
test("1584 satellites use 72 domains, independently valid bounded routes and cooperative replay", () => {
  const s = createScenario(PRESETS[1].config, DEFAULT_EPOCH_MS, 0, 1573);
  s.routing.algorithm = "mcsr";
  s.durationUs = 1000000;
  const e = new SimulationEngine(s, undefined, true);
  const r = finish(e, 500);
  assert.equal(r.mcsr!.domains.length, 72);
  assert.ok(r.path.length > 40);
  assert.equal(r.routingAnalyses[0].mcsr!.allCandidatesGuaranteed, false);
  assert.ok(e.snapshot().pathValid);
  assert.ok(r.routingAnalyses[0].search!.boundedPruned! > 0);
  assert.equal(r.completed, true);
});

test("attribute batches, stale installations and injected strategy validation remain independent of bounded search", () => {
  const s = example();
  s.controlTransport.mode = "fixed";
  s.mcsrSearch = searchDefaults(16, "bounded");
  s.routing.service = "TS";
  s.linkMetricUpdates = [
    {
      atUs: 500001,
      linkId: "0:1",
      bufferCapacityPackets: 1000,
      queuedPackets: 950,
      jitterMs: 1,
    },
  ];
  const e = new SimulationEngine(s);
  const count = e.result().routingAnalyses.length;
  e.advanceTo(599999);
  assert.equal(e.result().routingAnalyses.length, count);
  e.advanceTo(602000);
  assert.ok(e.result().routingAnalyses.length > count);
  const copy = e.graph();
  copy.links[0].knownAvailable = !copy.links[0].knownAvailable;
  assert.notEqual(
    copy.links[0].knownAvailable,
    e.graph().links[0].knownAvailable,
  );
  assert.throws(
    () =>
      new SimulationEngine(s, {
        name: "invalid",
        calculate: () => [
          {
            nodes: [0],
            propagationDelayMs: 0,
            availableBufferRatio: 1,
            jitterMs: 0,
          },
        ],
      }),
    /endpoints/,
  );
});
test("72 and 1584 MCSR services recover using validated far and near endpoint routes", () => {
  for (const n of [72, 1584])
    for (const service of ["LS", "TS", "HR"] as const) {
      const s = normalizeScenario(
        JSON.parse(readFileSync(`examples/mcsr-${n}.json`, "utf8")),
      );
      s.durationUs = 26000000;
      s.failures = s.failures.filter((f) => f.atUs <= s.durationUs);
      s.linkMetricUpdates = s.linkMetricUpdates.filter(
        (f) => f.atUs <= s.durationUs,
      );
      s.routing.service = service;
      const e = new SimulationEngine(s);
      const r = finish(e, 500);
      assert.equal(r.validForAnalysis, true);
      assert.equal(r.completed, true);
      assert.ok(e.snapshot().pathValid);
      if (service === "LS")
        assert.ok(
          r.serviceOutages.some(
            (o) =>
              o.startedUs === 20000000 &&
              o.recoveredUs !== null &&
              ["reserve", "recalculate"].includes(o.recoveryMechanism!),
          ),
        );
      if (n === 1584) {
        const selected = r.routingAnalyses[0].candidates.find(
          (c) => c.status === "selected",
        )!;
        assert.equal(
          selected.metrics!.availableBufferRatio,
          service === "LS" ? 0.4 : 1,
        );
        assert.equal(selected.metrics!.jitterMs, service === "LS" ? 20 : 0);
      }
      for (const a of r.routingAnalyses)
        for (const c of a.candidates)
          if (c.status === "selected" && service === "HR")
            assert.ok(c.metrics!.jitterMs < 15);
    }
  for (const config of PRESETS.map((p) => p.config)) {
    const s = createScenario(config, DEFAULT_EPOCH_MS, 0, 1);
    s.routing.algorithm = "mcsr";
    const e = new SimulationEngine(s);
    assert.deepEqual(e.result().path, [0, 1]);
  }
});

test("40 small weighted graphs calibrate bounded service choices against the exact oracle", () => {
  let missing = 0;
  for (let seed = 0; seed < 40; seed++) {
    const links: ReturnType<typeof link>[] = [];
    for (let a = 0; a < 8; a++)
      for (let b = a + 1; b < 8; b++)
        if ((a * 17 + b * 13 + seed * 7) % 5 < 2)
          links.push(
            link(
              a,
              b,
              1 + ((a + b + seed) % 4),
              0.3 + ((a * 3 + b + seed) % 7) / 10,
              (a + b + seed) % 6,
            ),
          );
    const graph = { nodeCount: 8, links },
      c = new McsrController(
        { planes: 2, perPlane: 4 },
        { planesPerDomain: 1, satellitesPerDomain: 2 },
        graph,
        0,
        searchDefaults(8, "bounded"),
        7,
      );
    const bounded = c.calculate(0, 7),
      exact = findDominantPaths(graph, 0, 7);
    missing += exact.filter(
      (p) => !bounded.some((b) => p.nodes.join(":") === b.nodes.join(":")),
    ).length;
    for (const service of ["LS", "TS", "HR"] as const)
      assert.deepEqual(
        analyseCandidates(bounded, service).selected,
        analyseCandidates(exact, service).selected,
      );
  }
  assert.equal(missing, 0);
  console.log(
    "bounded calibration: 40 graphs, 120 service choices, 0 choice differences, 0 missing exact candidates; no general completeness guarantee",
  );
});
