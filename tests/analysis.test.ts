import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  comparisonScenario,
  csv,
  distribution,
  environmentKey,
  repeatSummary,
  runAnalysis,
  summarize,
  validateComparison,
} from "../src/analysis";
import type { AnalysisRun, ComparisonReport } from "../src/analysis";
import {
  createScenario,
  DEFAULT_EPOCH_MS,
  normalizeScenario,
  SimulationEngine,
} from "../src/engine";
const scenario = () =>
  normalizeScenario(
    JSON.parse(readFileSync("examples/mcsr-routing.json", "utf8")),
  );
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function makeRun(algorithm: "bfs" | "mcsr" = "mcsr"): AnalysisRun {
  const input = comparisonScenario(scenario(), algorithm),
    { result, ...data } = runAnalysis(input);
  return {
    id: algorithm,
    algorithm,
    service: input.routing.service,
    scenario: input,
    repetition: 1,
    status: "completed",
    error: null,
    failureAtUs: null,
    logicalHash: hash(result),
    ...data,
  };
}
function report(): ComparisonReport {
  return {
    analysisVersion: 1,
    createdAt: new Date().toISOString(),
    metadata: {},
    sampleIntervalUs: 1000000,
    runs: [makeRun("bfs"), makeRun("mcsr")],
  };
}
test("analysis samples and budgets preserve complete logical results without leaking mutable engine state", () => {
  for (const file of [
    "examples/mcsr-routing.json",
    "examples/mcsr-72.json",
    "examples/ground-72.json",
  ]) {
    const input = normalizeScenario(JSON.parse(readFileSync(file, "utf8")));
    input.durationUs = Math.min(input.durationUs, 26000000);
    input.failures = input.failures.filter((e) => e.atUs <= input.durationUs);
    input.linkMetricUpdates = input.linkMetricUpdates.filter(
      (e) => e.atUs <= input.durationUs,
    );
    const engine = new SimulationEngine(input, undefined, true, {
      render: false,
    });
    assert.throws(() => engine.analysisSnapshot(), /완료/);
    while (!engine.advanceTo(input.durationUs, 500)) engine.drainDeltas();
    const expected = engine.result();
    const saved = engine.analysisSnapshot();
    saved.path.length = 0;
    assert.deepEqual(engine.result(), expected);
    for (const budget of [1, 37, 500]) {
      const actual = runAnalysis(input, {
        budget,
        sampleIntervalUs: budget === 1 ? 250000 : 1000000,
      });
      assert.deepEqual(actual.result, expected);
      assert.ok(actual.samples.every((s) => s.timeUs < input.durationUs));
      assert.equal(actual.samples[0].timeUs, 0);
    }
  }
});
test("sampling uses actual path geometry and both ground access propagation legs", () => {
  const input = normalizeScenario(
    JSON.parse(readFileSync("examples/ground-72.json", "utf8")),
  );
  const engine = new SimulationEngine(input, undefined, true);
  while (!engine.advanceTo(0, 500)) engine.drainDeltas();
  const sample = engine.analysisSnapshot(),
    frame = engine.progress();
  assert.equal(sample.available, true);
  assert.deepEqual(sample.metrics, frame.currentPathMetrics.candidate);
  assert.equal(sample.endToEndPropagationMs, frame.groundPropagationDelayMs);
  assert.equal(sample.hopCount, sample.path.length - 1);
});
test("distributions, censored outages, failed routes and switch counts have explicit denominators", () => {
  assert.deepEqual(distribution([]), {
    count: 0,
    mean: null,
    median: null,
    p95: null,
    min: null,
    max: null,
  });
  assert.deepEqual(distribution([4, 1, 3, 2]), {
    count: 4,
    mean: 2.5,
    median: 2.5,
    p95: 4,
    min: 1,
    max: 4,
  });
  assert.throws(() => distribution([NaN]));
  const { result, samples } = runAnalysis(scenario());
  const changed = structuredClone(result);
  changed.events = [
    { atUs: 0, type: "route-installed", path: [0, 1, 3] },
    { atUs: 1, type: "route-installed", path: [0, 1, 3] },
    { atUs: 2, type: "route-installed", path: [] },
    { atUs: 3, type: "route-installed", path: [0, 1, 3] },
    { atUs: 4, type: "route-installed", path: [0, 2, 3] },
    { atUs: 5, type: "route-installed", path: [1, 2, 3] },
    { atUs: 6, type: "route-discarded", path: [1, 3] },
  ];
  const data = summarize(changed, samples);
  assert.equal(data.summary.pathSwitches, 1);
  assert.equal(
    data.stages.filter((e) => e.type === "source-informed").length,
    result.serviceOutages.filter((o) => o.sourceInformedUs !== null).length,
  );
  assert.equal(
    data.summary.reserveRecoveryUs.count,
    result.serviceOutages.filter(
      (o) =>
        o.reason !== "initial-unreachable" &&
        o.recoveredUs !== null &&
        o.recoveryMechanism === "reserve",
    ).length,
  );

  assert.equal(
    data.summary.hops.count,
    samples.filter((s) => s.available).length,
  );
  const unavailable = samples.map((s) => ({
    ...s,
    available: false,
    metrics: null,
    hopCount: null,
    endToEndPropagationMs: null,
  }));
  assert.equal(summarize(result, unavailable).summary.delay.mean, null);
  assert.equal(
    summarize(result, unavailable).summary.availability,
    result.availability,
  );
});
test("zero exposure, identity and a bounded failure are never converted into zero-cost success", () => {
  const identity = createScenario(
    { planes: 1, perPlane: 8, altitude: 2000, inclination: 0, phase: 0 },
    DEFAULT_EPOCH_MS,
    0,
    0,
  );
  identity.durationUs = 1000000;
  const initial = new SimulationEngine(identity);
  assert.equal(summarize(initial.result(), []).summary.availability, null);
  assert.equal(summarize(initial.result(), []).summary.delay.count, 0);
  const run = runAnalysis(identity);
  assert.equal(run.samples[0].hopCount, 0);
  assert.equal(run.samples[0].metrics!.propagationDelayMs, 0);
  const input = scenario();
  input.mcsrSearch.mode = "bounded";
  input.mcsrSearch.expansionLimit = 1;
  assert.throws(() => runAnalysis(input), /예산/);
  const duringRun = scenario();
  duringRun.mcsrSearch.mode = "bounded";
  duringRun.mcsrSearch.controlEventLimit = 1;
  const failure = runAnalysis(duringRun);
  assert.equal(failure.result.completed, false);
  assert.equal(failure.result.validForAnalysis, false);
  assert.ok(failure.result.failure);
});
test("comparison validation rejects incompatible inputs and malformed imported display data", () => {
  const valid = report();
  assert.equal(validateComparison(valid), valid);
  assert.equal(
    environmentKey(valid.runs[0].scenario),
    environmentKey(valid.runs[1].scenario),
  );
  for (const corrupt of [
    (r: ComparisonReport) => {
      r.analysisVersion = 2 as 1;
    },
    (r: ComparisonReport) => {
      r.runs[1].scenario.epochMs += 1000;
    },
    (r: ComparisonReport) => {
      (r.runs[1].scenario as any).schemaVersion = 8;
    },
    (r: ComparisonReport) => {
      r.metadata.expectedRuns = 6;
    },
    (r: ComparisonReport) => {
      r.runs[1].samples[0].timeUs = -1;
    },
    (r: ComparisonReport) => {
      r.runs[1].samples[0].path = [0, 0];
    },
    (r: ComparisonReport) => {
      r.runs[1].summary!.availability = 2;
    },
    (r: ComparisonReport) => {
      r.runs[1].decisions[0].selected = {} as any;
    },
    (r: ComparisonReport) => {
      r.runs[1].id = r.runs[0].id;
    },
  ]) {
    const copy = structuredClone(valid);
    corrupt(copy);
    assert.throws(() => validateComparison(copy));
  }
  assert.equal(repeatSummary(valid.runs).length, 2);
  const mismatched = structuredClone(valid.runs[0]);
  mismatched.logicalHash = "changed";
  assert.equal(
    repeatSummary([valid.runs[0], mismatched])[0].logicalMatch,
    false,
  );
});
test("CSV preserves quotes/newlines, missing values and guards spreadsheet formulas", () => {
  assert.equal(
    csv([{ a: 'a,"b"\nc', b: null, c: "=1+1", d: -2 }]),
    'a,b,c,d\r\n"a,""b""\nc",,\'=1+1,-2\r\n',
  );
});
test("CLI emits paired, repeatable JSON/CSV/raw artifacts and refuses to overwrite a prior experiment", () => {
  const root = mkdtempSync(join(tmpdir(), "mcsr-analysis-test-")),
    out = join(root, "run");
  const command = [
    "--import",
    "tsx",
    resolve("scripts/analyze-compare.ts"),
    "examples/mcsr-routing.json",
    "--output",
    out,
    "--seconds",
    "3",
    "--services",
    "LS,TS,HR",
    "--repeat",
    "2",
  ];
  const process = spawnSync(globalThis.process.execPath, command, {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(process.status, 0, process.stderr);
  const data = validateComparison(
    JSON.parse(readFileSync(join(out, "comparison.json"), "utf8")),
  );
  assert.equal(data.runs.length, 12);
  assert.ok(
    repeatSummary(data.runs).every((g) => g.logicalMatch && g.completed === 2),
  );
  for (const run of data.runs) {
    const raw = JSON.parse(
      gunzipSync(readFileSync(join(out, run.rawResultFile!))).toString(),
    );
    assert.equal(hash(raw.result), run.logicalHash);
  }
  for (const file of ["summary.csv", "samples.csv", "outages.csv"])
    assert.ok(existsSync(join(out, file)));
  const original = readFileSync(join(out, "comparison.json"), "utf8");
  assert.notEqual(
    spawnSync(globalThis.process.execPath, command, {
      encoding: "utf8",
      timeout: 30000,
    }).status,
    0,
  );
  assert.equal(readFileSync(join(out, "comparison.json"), "utf8"), original);
  const invalid = scenario();
  invalid.mcsrSearch.mode = "bounded";
  invalid.mcsrSearch.expansionLimit = 1;
  const inputFile = join(root, "failure.json"),
    failedOut = join(root, "failed-run");
  writeFileSync(inputFile, JSON.stringify(invalid));
  const failed = spawnSync(
    globalThis.process.execPath,
    [
      "--import",
      "tsx",
      resolve("scripts/analyze-compare.ts"),
      inputFile,
      "--output",
      failedOut,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(failed.status, 1, failed.stderr);
  const failureReport = validateComparison(
    JSON.parse(readFileSync(join(failedOut, "comparison.json"), "utf8")),
  );
  assert.equal(
    failureReport.runs.find((r) => r.algorithm === "bfs")!.status,
    "completed",
  );
  const failedMcsr = failureReport.runs.find((r) => r.algorithm === "mcsr")!;
  assert.equal(failedMcsr.status, "failed");
  assert.equal(failedMcsr.summary, null);
  assert.ok(failedMcsr.error);
});
