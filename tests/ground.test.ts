import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GroundAccess,
  GroundMetrics,
  defaultGround,
  groundPosition,
  elevationDeg,
  validateGround,
} from "../src/ground.ts";
import type { GroundView, GroundPoint } from "../src/ground.ts";
import { EARTH_RADIUS, positions, PRESETS } from "../src/model.ts";
import type { Vec3 } from "../src/model.ts";
import {
  createScenario,
  normalizeScenario,
  validateScenario,
  SimulationEngine,
  DEFAULT_EPOCH_MS,
  SECOND,
  edgeId,
} from "../src/engine.ts";
import { MetricsEngine } from "../src/metrics.ts";
import { TopologyStream } from "../src/topologyStream.ts";
import { McsrController } from "../src/mcsr.ts";
import { searchDefaults } from "../src/boundedSearch.ts";
import { findDominantPaths } from "../src/routing.ts";
const under = (v: Vec3): GroundPoint => ({
  latitude: (Math.atan2(v.z, Math.hypot(v.x, v.y)) * 180) / Math.PI,
  longitude: (Math.atan2(v.y, v.x) * 180) / Math.PI,
});
function scenario(algorithm: "bfs" | "mcsr" = "bfs", large = false) {
  const config = PRESETS[large ? 1 : 0].config;
  const s = createScenario(config, DEFAULT_EPOCH_MS);
  const p = positions(config, 0, s.epochMs);
  s.durationUs = 600 * SECOND;
  s.routing.algorithm = algorithm;
  s.ground = {
    ...defaultGround(),
    ut: under(p[0]),
    gs: under(p[large ? 1573 : 61]),
  };
  return s;
}
function finish(e: SimulationEngine, budget = Infinity) {
  while (!e.advanceTo(e.scenario.durationUs, budget)) e.drainDeltas();
  return e.result();
}
test("ground coordinates, spherical elevation and settings reject invalid inputs", () => {
  const point = { latitude: 0, longitude: 0 },
    g = groundPosition(point);
  assert.deepEqual(g, { x: EARTH_RADIUS, y: 0, z: 0 });
  assert.equal(
    elevationDeg(point, { x: EARTH_RADIUS + 550000, y: 0, z: 0 }),
    90,
  );
  assert.equal(
    elevationDeg(point, { x: -EARTH_RADIUS - 550000, y: 0, z: 0 }),
    -90,
  );
  assert.ok(
    Math.abs(elevationDeg(point, { x: EARTH_RADIUS, y: 1000000, z: 0 })) < 1e-9,
  );
  for (const invalid of [
    undefined,
    { ...defaultGround(), ut: { latitude: 91, longitude: 0 } },
    { ...defaultGround(), gs: { latitude: 0, longitude: Infinity } },
    { ...defaultGround(), minimumElevationDeg: -1 },
    { ...defaultGround(), handoverDelayUs: 0.1 },
  ])
    assert.throws(() => validateGround(invalid as never));
  const s = scenario();
  s.routing.algorithm = "candidate-paths";
  assert.throws(() => validateScenario(s), /수동 후보/);
});
test("access keeps a visible attachment, breaks ties by ID and applies logical handover delay", () => {
  const point = { latitude: 0, longitude: 0 },
    up = { x: EARTH_RADIUS + 550000, y: 0, z: 0 },
    side = { x: EARTH_RADIUS + 550000, y: 100000, z: 0 },
    down = { x: -EARTH_RADIUS - 550000, y: 0, z: 0 };
  const access = new GroundAccess({ ...defaultGround(), ut: point, gs: point });
  access.update([up, up], 0);
  assert.equal(access.source, 0);
  assert.equal(access.ready(0), true);
  access.update([side, up], SECOND);
  assert.equal(
    access.source,
    0,
    "a higher new satellite does not cause needless switching",
  );
  access.update([down, up], 2 * SECOND);
  assert.equal(access.source, 1);
  assert.equal(access.ready(2 * SECOND + 99999), false);
  assert.equal(access.ready(2 * SECOND + 100000), true);
  access.update([down, down], 3 * SECOND);
  assert.equal(access.source, null);
  assert.equal(access.ready(4 * SECOND), false);
  assert.deepEqual(
    access.events.filter((e) => e.role === "ut").map((e) => e.kind),
    ["initial", "handover", "lost"],
  );
});
test("ground downtime is a continuous outage with exclusive access, handover and ISL intervals", () => {
  const attachment = {
    point: { latitude: 0, longitude: 0 },
    satelliteId: 0,
    readyAtUs: 0,
    ready: true,
    distanceM: 550000,
    elevationDeg: 90,
  };
  const connected: GroundView = {
    ut: attachment,
    gs: attachment,
    routePending: false,
    available: true,
  };
  const m = new GroundMetrics();
  m.observe(0, connected);
  m.observe(10, {
    ...connected,
    available: false,
    ut: { ...attachment, satelliteId: null },
  });
  m.observe(20, { ...connected, available: false, routePending: true });
  m.observe(30, { ...connected, available: false });
  m.observe(40, connected);
  const r = m.result(100);
  assert.equal(r.outageCount, 1);
  assert.equal(r.totalDowntimeUs, 30);
  assert.equal(r.availability, 0.7);
  assert.deepEqual(
    [r.accessDowntimeUs, r.handoverDowntimeUs, r.islDowntimeUs],
    [10, 10, 10],
  );
  assert.deepEqual(r.outages[0], {
    startedUs: 10,
    recoveredUs: 40,
    causes: ["access", "handover", "isl"],
  });
});
test("access change censors an unfinished ISL observation instead of manufacturing a recovery", () => {
  const m = new MetricsEngine(0, 1);
  m.observe(0, [0, 1], true, [], new Set());
  m.observe(10, [0, 1], false, ["0:1"], new Set());
  m.setMonitoring(20, false);
  m.setMonitoring(50, true, 2, 3);
  m.observe(50, [2, 3], true, [], new Set());
  const r = m.summary(100, true);
  assert.equal(r.monitoredUs, 70);
  assert.equal(r.totalDowntimeUs, 10);
  assert.equal(r.censoredCount, 1);
  assert.equal(r.recoveredCount, 0);
  assert.equal(r.unrecoveredCount, 0);
  assert.equal(r.meanOutageUs, null);
  assert.equal(r.serviceOutages[0].status, "censored");
});
test("unplaced or uncovered ground endpoints cannot become successful satellite-only service", () => {
  for (const algorithm of ["bfs", "mcsr"] as const) {
    const s = scenario(algorithm);
    s.durationUs = 3 * SECOND;
    s.ground!.gs = { latitude: 90, longitude: 0 };
    const e = new SimulationEngine(s),
      r = finish(e);
    assert.deepEqual(r.path, []);
    assert.equal(r.ground!.available, false);
    assert.equal(r.ground!.gs.satelliteId, null);
    assert.equal(r.groundService!.availability, 0);
    assert.equal(r.groundService!.accessDowntimeUs, s.durationUs);
    assert.equal(r.monitoredUs, 0);
    assert.equal(r.outageCount, 0);
    assert.equal(r.groundPropagationDelayMs, null);
  }
});
test("BFS and MCSR hand over a 72-satellite ground flow without resetting UTC, metrics or CSIB", () => {
  for (const algorithm of ["bfs", "mcsr"] as const) {
    const s = scenario(algorithm),
      e = new SimulationEngine(s);
    const r = finish(e);
    assert.equal(r.validForAnalysis, true);
    assert.equal(r.completed, true);
    assert.equal(r.ground!.available, true);
    assert.equal(r.path[0], r.ground!.ut.satelliteId);
    assert.equal(r.path.at(-1), r.ground!.gs.satelliteId);
    assert.ok(r.groundAccessEvents!.some((a) => a.kind === "handover"));
    assert.equal(r.groundService!.outageCount, 3);
    assert.equal(
      r.groundService!.handoverDowntimeUs,
      algorithm === "bfs" ? 306000 : 406000,
    );
    assert.equal(r.groundService!.accessDowntimeUs, 0);
    assert.equal(r.outageCount, 0, "handover is not an ISL recovery");
    assert.equal(
      r.monitoredUs + r.groundService!.handoverDowntimeUs,
      s.durationUs,
    );
    assert.equal(
      e.scenario.source,
      s.source,
      "dynamic attachments do not rewrite replay input",
    );
    assert.equal(e.scenario.epochMs, s.epochMs);
    assert.ok(
      r.events.some(
        (a) => a.atUs === 249000000 && a.type === "ground-attachment-changed",
      ),
    );
    assert.ok(
      r.groundPropagationDelayMs! >
        r.currentPathMetrics.candidate!.propagationDelayMs,
    );
    if (algorithm === "mcsr") {
      assert.equal(r.mcsr!.sourceDomain, r.mcsr!.membership[r.path[0]]);
      assert.ok(r.mcsr!.domains.some((d) => d.revision > 1));
      assert.ok(r.mcsr!.control!.stats.deliveredUpdates > 0);
    }
  }
});
test("a ground flow still records actual ISL detection and recovery independently of access", () => {
  for (const algorithm of ["bfs", "mcsr"] as const) {
    const s = scenario(algorithm);
    s.durationUs = 5 * SECOND;
    const initial = new SimulationEngine(s).snapshot().path;
    const id = edgeId(initial[2], initial[3]);
    s.failures = [
      { atUs: SECOND, linkId: id, down: true },
      { atUs: 3 * SECOND, linkId: id, down: false },
    ];
    const r = finish(new SimulationEngine(s));
    assert.ok(r.outageCount > 0);
    assert.ok(r.serviceOutages[0].recoveredUs !== null);
    assert.ok(r.serviceOutages[0].detectedUs !== null);
    assert.equal(r.groundService!.accessDowntimeUs, 0);
    assert.equal(r.groundService!.handoverDowntimeUs, 0);
    assert.equal(r.groundService!.totalDowntimeUs, r.totalDowntimeUs);
    assert.equal(r.serviceOutages[0].source, 0);
    assert.equal(r.serviceOutages[0].target, 61);
  }
});
test("1584-satellite BFS and MCSR ground paths validate and include both access propagation legs", () => {
  for (const algorithm of ["bfs", "mcsr"] as const) {
    const s = scenario(algorithm, true);
    s.durationUs = 2 * SECOND;
    const e = new SimulationEngine(s),
      r = finish(e);
    assert.equal(r.ground!.available, true);
    assert.equal(r.path[0], 0);
    assert.equal(r.path.at(-1), 1573);
    assert.equal(r.groundService!.availability, 1);
    assert.ok(
      r.groundPropagationDelayMs! >
        r.currentPathMetrics.candidate!.propagationDelayMs,
    );
    assert.equal(r.validForAnalysis, true);
  }
});
test("handover, checkpoint deltas and logical metrics replay identically across worker-size batches", () => {
  const s = scenario("mcsr");
  s.durationUs = 251 * SECOND;
  const synchronous = new SimulationEngine(s),
    expected = finish(synchronous);
  const e = new SimulationEngine(
    JSON.parse(JSON.stringify(s)),
    undefined,
    true,
  );
  while (!e.advanceTo(0, 3)) {}
  const stream = new TopologyStream();
  stream.reset(e.checkpoint());
  e.drainDeltas();
  while (!e.advanceTo(s.durationUs, 37)) {
    if (e.needsWork) continue;
    stream.receive(e.drainDeltas());
    assert.equal(stream.matches(e.checkpoint()), true);
  }
  const deltas = e.drainDeltas();
  stream.receive(deltas);
  assert.equal(stream.matches(e.checkpoint()), true);
  const before = stream.at(249 * SECOND - 1)!;
  assert.equal(before.ground!.ut.satelliteId, 0);
  const during = stream.at(249 * SECOND)!;
  assert.equal(during.ground!.ut.satelliteId, 41);
  assert.equal(during.ground!.available, false);
  const after = stream.at(249 * SECOND + 102000)!;
  assert.equal(after.ground!.available, true);
  assert.equal(after.mcsr!.sourceDomain, e.result().mcsr!.sourceDomain);
  assert.deepEqual(e.result(), expected);
  const exposed = e.progress();
  exposed.ground!.ut.satelliteId = -999;
  assert.notEqual(e.progress().ground!.ut.satelliteId, -999);
});
test("MCSR endpoint changes preserve learned CSIB and advertise new local endpoints before routing", () => {
  const links = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 0],
  ].map(([a, b]) => ({
    id: edgeId(a, b),
    sourceId: a,
    targetId: b,
    knownAvailable: true,
    metrics: { propagationDelayMs: 1, availableBufferRatio: 1, jitterMs: 0 },
  }));
  const graph = { nodeCount: 6, links };
  const c = new McsrController(
    { planes: 2, perPlane: 3 },
    { planesPerDomain: 1, satellitesPerDomain: 3 },
    graph,
    0,
    searchDefaults(6, "bounded"),
    3,
  );
  const ads = c.update(
    {
      ...graph,
      links: links.map((l) => ({
        ...l,
        metrics: { ...l.metrics, jitterMs: 1 },
      })),
    },
    1,
  );
  for (const ad of ads)
    for (const d of c.partition.domains) c.receive(ad, d.id, 2);
  const previous = c.view();
  c.setEndpoints(4, 2);
  assert.equal(c.sourceDomain, 1);
  assert.equal(c.endpointSummariesReady, false);
  assert.deepEqual(
    c.view().domains.map((d) => d.receivedVersions),
    previous.domains.map((d) => d.receivedVersions),
  );
  const updates = c.update(graph, 3);
  const beforeKey = c.inputKey();
  for (const ad of updates)
    for (const d of c.partition.domains) c.receive(ad, d.id, 4);
  assert.equal(c.endpointSummariesReady, true);
  assert.notEqual(
    c.inputKey(),
    beforeKey,
    "endpoint advertisements invalidate route input even when links are unchanged",
  );
  assert.deepEqual(c.calculate(4, 2), findDominantPaths(graph, 4, 2));
});
test("v8 migrates to satellite mode while v9 preserves and validates complete ground replay settings", () => {
  const old = JSON.parse(readFileSync("examples/mcsr-72.json", "utf8"));
  const migrated = normalizeScenario(old);
  assert.equal(migrated.schemaVersion, 9);
  assert.equal(migrated.ground, null);
  assert.deepEqual(migrated.mcsrSearch, old.mcsrSearch);
  const s = scenario();
  assert.deepEqual(normalizeScenario(JSON.parse(JSON.stringify(s))), s);
  assert.throws(
    () => normalizeScenario({ ...s, ground: undefined }),
    /지상 접속/,
  );
});

test("both ground endpoints can share one satellite without an artificial ISL hop", () => {
  for (const algorithm of ["bfs", "mcsr"] as const) {
    const s = scenario(algorithm);
    s.durationUs = 3 * SECOND;
    s.ground!.gs = s.ground!.ut;
    const r = finish(new SimulationEngine(s));
    assert.deepEqual(r.path, [0]);
    assert.equal(r.ground!.available, true);
    assert.equal(r.currentPathMetrics.candidate!.propagationDelayMs, 0);
    assert.ok(r.groundPropagationDelayMs! > 3);
    assert.equal(r.groundService!.totalDowntimeUs, 0);
  }
});

test("MCSR waits for the target endpoint summary over delayed control instead of claiming search failure", () => {
  const s = scenario("mcsr");
  s.durationUs = 251 * SECOND;
  s.controlTransport.mode = "fixed";
  s.notificationDelayUs = 500000;
  const e = new SimulationEngine(s);
  e.advanceTo(249 * SECOND + 102000);
  assert.equal(e.snapshot().ground!.available, false);
  assert.equal(e.snapshot().ground!.routePending, true);
  assert.equal(e.snapshot().failure, null);
  const r = finish(e);
  assert.equal(r.ground!.available, true);
  assert.equal(r.groundService!.islDowntimeUs, 0);
  assert.ok(r.groundService!.handoverDowntimeUs! >= 502000);
  assert.equal(r.outageCount, 0);
  assert.equal(r.validForAnalysis, true);
});

test("1584 MCSR waits for an interior destination summary across a real endpoint handover", () => {
  const s = scenario("mcsr", true);
  s.durationUs = 250 * SECOND;
  s.controlTransport.mode = "fixed";
  s.notificationDelayUs = 500000;
  s.mcsrSearch.delayPublishIntervalUs = 600 * SECOND;
  const e = new SimulationEngine(s);
  e.advanceTo(249 * SECOND + 102000);
  assert.equal(e.snapshot().ground!.ut.satelliteId, 21);
  assert.equal(e.snapshot().ground!.gs.satelliteId, 1572);
  assert.equal(e.snapshot().ground!.routePending, true);
  assert.equal(e.snapshot().ground!.available, false);
  const r = finish(e);
  assert.equal(r.validForAnalysis, true);
  assert.equal(r.ground!.available, true);
  assert.equal(r.path[0], 21);
  assert.equal(r.path.at(-1), 1572);
  assert.equal(r.mcsr!.sourceDomain, r.mcsr!.membership[21]);
  assert.ok(r.groundService!.handoverDowntimeUs >= 502000);
  assert.equal(r.outageCount, 0);
});
test("the ground example reacquires coverage after a gap with BFS and MCSR", () => {
  for (const algorithm of ["bfs", "mcsr"] as const) {
    const s = normalizeScenario(
      JSON.parse(readFileSync("examples/ground-72.json", "utf8")),
    );
    s.routing.algorithm = algorithm;
    const r = finish(new SimulationEngine(s));
    assert.equal(r.validForAnalysis, true);
    assert.equal(r.ground!.available, true);
    assert.equal(r.groundService!.accessDowntimeUs, 10 * SECOND);
    assert.ok(
      r.groundAccessEvents!.some(
        (e) => e.kind === "acquisition" && e.from === null,
      ),
    );
    assert.ok(
      r.groundService!.outages.some(
        (o) =>
          o.causes.includes("access") &&
          o.causes.includes("handover") &&
          o.recoveredUs !== null,
      ),
    );
  }
});
