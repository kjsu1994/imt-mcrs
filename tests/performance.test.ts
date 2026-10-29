import { groundLabel } from "../src/groundPresentation.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SimulationEngine, normalizeScenario } from "../src/engine.ts";
import { positions, position, PRESETS } from "../src/model.ts";
import { RuntimeProfile } from "../src/performance.ts";
import { FrameSamples } from "../src/browserPerformance.ts";
function finish(e: SimulationEngine, budget: number) {
  while (!e.advanceTo(e.scenario.durationUs, budget)) e.drainDeltas();
  e.drainDeltas();
  return JSON.parse(JSON.stringify(e.result()));
}
test("profiling, headless rendering and different execution budgets preserve complete logical results", () => {
  for (const file of [
    "examples/mcsr-72.json",
    "examples/mcsr-routing.json",
    "examples/ground-72.json",
  ]) {
    const s = normalizeScenario(JSON.parse(readFileSync(file, "utf8")));
    s.durationUs = Math.min(s.durationUs, 31000000);
    s.failures = s.failures.filter((f) => f.atUs <= s.durationUs);
    s.linkMetricUpdates = s.linkMetricUpdates.filter(
      (f) => f.atUs <= s.durationUs,
    );
    const expected = finish(new SimulationEngine(s, undefined, true), 500);
    for (const profile of ["off", "light", "detail"] as const) {
      const e = new SimulationEngine(s, undefined, true, {
        profile,
        render: false,
      });
      assert.throws(() => e.result());
      assert.deepEqual(finish(e, profile === "detail" ? 1 : 37), expected);
      assert.deepEqual(e.drainDeltas(), []);
      assert.throws(() => e.checkpoint(), /disabled/);
      const report = e.performanceReport();
      if (profile === "off") assert.equal(report, null);
      else {
        if (expected.mcsr?.control) {
          const stats = expected.mcsr.control.stats;
          assert.equal(
            report!.scopes["control.generate"].calls,
            stats.sentUpdates + stats.sentAcks,
          );
          assert.equal(
            report!.scopes["control.ack"].calls,
            stats.deliveredAcks,
          );
          assert.equal(
            report!.counters["control.records.acknowledged"],
            stats.acknowledged,
          );
        }
        assert.ok(report!.counters["queue.peakLength"] > 0);
        assert.equal(
          report!.counters["events.executed"],
          report!.counters["queue.popped"],
        );
        assert.ok(
          report!.counters["queue.pushed"] >= report!.counters["queue.popped"],
        );
        assert.ok(
          Object.values(report!.scopes).every(
            (s) =>
              s.calls > 0 &&
              s.inclusiveMs >= s.exclusiveMs &&
              s.exclusiveMs >= 0,
          ),
        );
      }
    }
  }
});
test("GS to UT presentation preserves legacy endpoint keys", () => {
  assert.equal(groundLabel("ut"), "GS");
  assert.equal(groundLabel("gs"), "UT");
});
test("reused orbit storage exactly matches single-node positions and keeps object identities", () => {
  const result = positions(PRESETS[1].config, 0, 1767225600000),
    first = result[0];
  assert.equal(
    positions(PRESETS[1].config, 123.456, 1767225600000, result),
    result,
  );
  assert.equal(result[0], first);
  for (let id = 0; id < result.length; id++)
    assert.deepEqual(
      result[id],
      position(PRESETS[1].config, id, 123.456, 1767225600000),
    );
  positions(PRESETS[0].config, 0, 1767225600000, result);
  assert.equal(result.length, 72);
});
test("nested wall-time scopes avoid double counting and frame samples stay bounded", () => {
  const p = new RuntimeProfile("detail");
  p.enter("outer");
  p.enter("inner");
  p.leave();
  p.leave();
  const r = p.report();
  assert.equal(r.scopes.outer.calls, 1);
  assert.ok(
    Math.abs(
      r.scopes.outer.inclusiveMs -
        r.scopes.outer.exclusiveMs -
        r.scopes.inner.inclusiveMs,
    ) < 1e-6,
  );
  const frames = new FrameSamples();
  for (let i = 1; i <= 1200; i++) frames.sample(i * 20, 2, 3);
  assert.deepEqual(frames.report(), {
    frames: 1200,
    windowFrames: 600,
    fps: 50,
    frameP95Ms: 20,
    updateP95Ms: 2,
    renderSubmissionP95Ms: 3,
  });
});
