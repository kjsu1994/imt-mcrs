import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SimulationEngine,
  createScenario,
  DEFAULT_EPOCH_MS,
} from "../src/engine.ts";
import { TopologyStream } from "../src/topologyStream.ts";
const config = {
  planes: 1,
  perPlane: 8,
  altitude: 2000,
  inclination: 0,
  phase: 0,
};
function engine() {
  return new SimulationEngine({
    ...createScenario(config, DEFAULT_EPOCH_MS, 0, 3),
    durationUs: 3000000,
    failures: [
      { atUs: 1000000, linkId: "0:1", down: true },
      { atUs: 1050000, linkId: "0:1", down: false },
    ],
  });
}
test("both transitions inside one delivery are visible only at their own display times", () => {
  const e = engine(),
    stream = new TopologyStream();
  stream.reset(e.checkpoint());
  e.advanceTo(1100000);
  const deltas = e.drainDeltas();
  assert.equal(deltas.length, 2);
  stream.receive(deltas);
  assert.equal(
    stream.at(999999)!.links.find((l) => l.id === "0:1")!.physical,
    true,
  );
  assert.equal(
    stream.at(1000000)!.links.find((l) => l.id === "0:1")!.physical,
    false,
  );
  assert.equal(stream.at(1049999)!.pathValid, false);
  assert.equal(stream.at(1050000)!.pathValid, true);
  assert.equal(
    stream.at(1050000)!.links.find((l) => l.id === "0:1")!.physical,
    true,
  );
  assert.equal(stream.pendingCount, 0);
  assert.equal(stream.matches(e.checkpoint()), true);
});
test("missing or out of order revisions are rejected, reset discards future display changes", () => {
  const e = engine(),
    stream = new TopologyStream(),
    initial = e.checkpoint();
  stream.reset(initial);
  e.advanceTo(1100000);
  const deltas = e.drainDeltas();
  assert.throws(() => stream.receive([deltas[1]]));
  stream.receive([deltas[0]]);
  assert.throws(() => stream.receive([deltas[0]]));
  assert.equal(stream.matches(e.checkpoint()), false);
  stream.reset(e.checkpoint());
  assert.equal(stream.pendingCount, 0);
  assert.equal(stream.at(1100000)!.pathValid, true);
  stream.reset(initial);
  assert.equal(stream.at(0)!.stateRevision, 0);
  assert.equal(stream.pendingCount, 0);
});
test("route installation is delayed until its timestamp and checkpoint reconstruction is exact", () => {
  const e = new SimulationEngine({
    ...createScenario(config, DEFAULT_EPOCH_MS, 0, 3),
    durationUs: 3000000,
    failures: [{ atUs: 1000000, linkId: "0:1", down: true }],
  });
  const stream = new TopologyStream();
  stream.reset(e.checkpoint());
  e.advanceTo(1300000);
  stream.receive(e.drainDeltas());
  assert.deepEqual(stream.at(1201999)!.path, [0, 1, 2, 3]);
  assert.deepEqual(stream.at(1202000)!.path, [0, 7, 6, 5, 4, 3]);
  assert.equal(stream.at(1202000)!.pathValid, true);
  assert.equal(stream.matches(e.checkpoint()), true);
});
test("1584 satellites generate no link payload without state changes and all deltas match checkpoints", () => {
  const e = new SimulationEngine(
    createScenario(
      { planes: 72, perPlane: 22, altitude: 550, inclination: 53, phase: 1 },
      DEFAULT_EPOCH_MS,
    ),
  );
  const stream = new TopologyStream();
  stream.reset(e.checkpoint());
  e.advanceTo(100000);
  assert.deepEqual(e.drainDeltas(), []);
  e.addFailure({ atUs: 1000000, linkId: "0:1", down: true });
  e.addFailure({ atUs: 2050000, linkId: "0:1", down: false });
  let transmittedLinks = 0;
  for (let t = 1000000; t <= 12000000; t += 1000000) {
    e.advanceTo(t);
    const ds = e.drainDeltas();
    transmittedLinks += ds.reduce((n, d) => n + d.changedLinks.length, 0);
    stream.receive(ds);
    assert.equal(stream.matches(e.checkpoint()), true);
    assert.deepEqual(stream.at(t)!.links, e.checkpoint().links);
  }
  assert.ok(transmittedLinks > 0 && transmittedLinks < 3146);
  console.log(
    `TOPOLOGY links=${e.edges.length}, changedLinks over 12s=${transmittedLinks}, previous 10Hz links=${e.edges.length * 120}`,
  );
});
